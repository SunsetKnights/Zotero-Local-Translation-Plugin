import {
  MAX_INPUT_CODE_POINTS,
  isBlank,
  normalizeText,
} from './normalize';
import type {
  ErrorCode,
  ReadyInfo,
  SelectionSnapshot,
  TranslationTask,
} from '../../shared/types';
import type { ModelUsage, TranslationHandlers } from '../native/manager';
import { isKnownErrorCode } from './errors';

export interface HostPort {
  readonly isReady: boolean;
  readonly info: ReadyInfo | null;
  /** True while the engine still owns a request, including the settle window after a cancel. */
  readonly busy: boolean;
  /**
   * Takes the model usage right before asset preparation and the load start.
   * It is released by `complete()`/`cancel()`/`dispose()`, and the manager drops
   * it on the native terminal frame as well.
   */
  acquireUsage(requestId: string): ModelUsage;
  ensureReady(): Promise<ReadyInfo>;
  translate(text: string, handlers: TranslationHandlers, requestId?: string): Promise<string>;
  cancel(requestId: string): Promise<boolean>;
}

export interface ControllerDeps {
  host: HostPort;
  now?(): number;
  onUpdate(task: TranslationTask): void;
  reportError?(task: TranslationTask): void;
}

export interface TranslateOptions {
  /** Presents the selected task before asset preparation or model loading starts. */
  onTaskAccepted?(task: TranslationTask): void;
}

/**
 * Terminal task records are kept so the window/retry path can still read them,
 * but the history is bounded: a long-lived process (the default residency
 * model) must not accumulate one record per selection forever.
 */
const MAX_TASK_RECORDS = 50;

let counter = 0;

function nextRequestId(): string {
  counter += 1;
  return `req-${Date.now().toString(36)}-${counter}`;
}

export class TranslationController {
  private readonly tasks = new Map<string, TranslationTask>();
  private readonly generations = new Map<string, number>();
  private readonly usages = new Map<string, ModelUsage>();
  private activeRequestId: string | null = null;
  private activeReaderKey: string | null = null;
  private disposed = false;

  constructor(private readonly deps: ControllerDeps) {}

  get activeTask(): TranslationTask | null {
    return this.activeRequestId ? this.tasks.get(this.activeRequestId) ?? null : null;
  }

  getTask(requestId: string): TranslationTask | null {
    return this.tasks.get(requestId) ?? null;
  }

  async translateSelection(snapshot: SelectionSnapshot, options: TranslateOptions = {}): Promise<TranslationTask> {
    if (this.disposed) {
      throw new Error('controller disposed');
    }

    const now = this.deps.now ?? Date.now;
    const present = (task: TranslationTask): TranslationTask => {
      options.onTaskAccepted?.(task);
      return task;
    };
    const generation = this.nextGeneration(snapshot.readerKey);
    const normalized = normalizeText(snapshot.rawText);

    const base: TranslationTask = {
      requestId: nextRequestId(),
      readerKey: snapshot.readerKey,
      generation,
      rawText: snapshot.rawText,
      normalizedText: normalized.text,
      state: 'preparing',
      partialText: '',
      resultText: '',
      errorCode: null,
      truncated: false,
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
    };

    if (isBlank(normalized.text)) {
      return present(this.finishImmediately(base, 'failed', 'NO_SELECTION', now));
    }
    if (normalized.inputLength > MAX_INPUT_CODE_POINTS) {
      return present(this.finishImmediately(base, 'failed', 'INPUT_TOO_LONG', now));
    }

    while (this.activeRequestId) {
      if (this.activeReaderKey === snapshot.readerKey) {
        const active = this.activeTask;
        // Only coalesce repeated clicks while this reader's task is active.
        // Completed translations are never reused as the next request's result.
        if (active?.normalizedText === normalized.text) return present(active);
        // same reader submitted a new selection: cancel the old task first
        await this.cancel(this.activeRequestId, 'superseded');
        if (this.disposed || this.generations.get(snapshot.readerKey) !== generation) {
          // A stale submission must not open a window after the newer one was
          // closed. Only deliver its terminal update to an existing view.
          return this.finishImmediately(base, 'cancelled', 'CANCELLED', now);
        }
      }
      else {
        // another reader owns the single inference slot
        const busy = this.finishImmediately(base, 'failed', 'ENGINE_BUSY', now);
        this.deps.reportError?.(busy);
        return present(busy);
      }
    }

    this.tasks.set(base.requestId, base);
    this.activeRequestId = base.requestId;
    this.activeReaderKey = snapshot.readerKey;
    this.deps.onUpdate(base);
    present(base);

    try {
      // Cover asset preparation and the load handshake, not only inference:
      // a manual release must already see this task as "in use".
      this.usages.set(base.requestId, this.deps.host.acquireUsage(base.requestId));
    }
    catch (e) {
      this.complete(base, 'failed', normalizeErrorCode(e));
      return this.tasks.get(base.requestId)!;
    }

    const handlers = this.makeHandlers(base.requestId, now);

    try {
      await this.deps.host.ensureReady();
    }
    catch (e) {
      const task = this.tasks.get(base.requestId);
      if (task?.state === 'preparing') {
        const code = normalizeErrorCode(e);
        this.complete(task, 'failed', code);
      }
      return this.tasks.get(base.requestId)!;
    }

    const task = this.tasks.get(base.requestId);
    if (!task || task.state !== 'preparing') {
      // cancelled or superseded while the engine was starting
      this.releaseUsage(base.requestId);
      return task ?? base;
    }

    // A cancel clicked a moment ago may still be settling inside the engine. Give
    // it a short window instead of surfacing a spurious ENGINE_BUSY.
    const settleDeadline = Date.now() + 1500;
    while (this.deps.host.busy && Date.now() < settleDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this.disposed || task.state !== 'preparing') return task;

    task.state = 'running';
    task.startedAt = now();
    this.deps.onUpdate(task);

    try {
      await this.deps.host.translate(normalized.text, handlers, base.requestId);
    }
    catch (e) {
      const current = this.tasks.get(base.requestId);
      if (current && (current.state === 'running' || current.state === 'preparing')) {
        this.complete(current, 'failed', normalizeErrorCode(e));
      }
    }

    return this.tasks.get(base.requestId)!;
  }

  async cancel(requestId: string, reason: 'user' | 'superseded' = 'user'): Promise<boolean> {
    const task = this.tasks.get(requestId);
    if (!task) return false;
    if (task.state === 'succeeded' || task.state === 'failed' || task.state === 'cancelled') {
      return false;
    }

    // mark first so late deltas and results are ignored
    task.state = 'cancelled';
    task.errorCode = 'CANCELLED';
    task.finishedAt = (this.deps.now ?? Date.now)();
    this.releaseSlot(requestId);
    // This only drops a preparation lease. Once translate() handed the request
    // to the helper, the native terminal frame (or process recovery) keeps the
    // engine busy; releasing here would let a release race the cancel.
    this.releaseUsage(requestId);
    this.deps.onUpdate(task);

    const cancelled = await this.deps.host.cancel(requestId).catch(() => false);
    // The manager waits for the terminal frame before returning, but keep the
    // short settle loop for a host implementation that only resolves the slot.
    const deadline = Date.now() + 2000;
    while (this.deps.host.busy && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    this.pruneTasks();
    void reason;
    return cancelled;
  }

  dispose(): void {
    this.disposed = true;
    if (this.activeRequestId) {
      const task = this.tasks.get(this.activeRequestId);
      if (task) {
        task.state = 'cancelled';
        task.errorCode = 'CANCELLED';
        this.deps.onUpdate(task);
      }
    }
    for (const usage of this.usages.values()) {
      try {
        usage.release();
      }
      catch {
        // best effort
      }
    }
    this.usages.clear();
    this.tasks.clear();
    this.activeRequestId = null;
    this.activeReaderKey = null;
  }

  private releaseUsage(requestId: string): void {
    const usage = this.usages.get(requestId);
    if (!usage) return;
    this.usages.delete(requestId);
    try {
      usage.release();
    }
    catch {
      // best effort
    }
  }

  private nextGeneration(readerKey: string): number {
    const next = (this.generations.get(readerKey) ?? 0) + 1;
    this.generations.set(readerKey, next);
    return next;
  }

  private makeHandlers(requestId: string, now: () => number): TranslationHandlers {
    const current = (): TranslationTask | null => {
      const task = this.tasks.get(requestId);
      if (!task) return null;
      if (task.state === 'cancelled' || task.state === 'failed' || task.state === 'succeeded') return null;
      return task;
    };

    return {
      onStarted: () => {
        const task = current();
        if (!task) return;
        task.state = 'running';
        task.startedAt = task.startedAt ?? now();
        this.deps.onUpdate(task);
      },
      onDelta: (_seq, text) => {
        const task = current();
        if (!task) return;
        task.partialText += text;
        this.deps.onUpdate(task);
      },
      onSuccess: (text, meta) => {
        const task = current();
        if (!task) return;
        task.resultText = text;
        task.partialText = text;
        task.truncated = meta.truncated;
        if (meta.truncated) {
          this.complete(task, 'failed', 'OUTPUT_TRUNCATED');
          return;
        }
        this.complete(task, 'succeeded', null);
      },
      onError: (code, _retryable, _detail) => {
        const task = current();
        if (!task) return;
        task.partialText = '';
        this.complete(task, 'failed', code);
        if (code === 'ENGINE_BUSY') {
          this.deps.reportError?.(task);
        }
      },
      onCancelled: () => {
        const task = current();
        if (!task) return;
        task.state = 'cancelled';
        task.errorCode = 'CANCELLED';
        this.complete(task, 'cancelled', 'CANCELLED');
      },
    };
  }

  private complete(task: TranslationTask, state: TranslationTask['state'], errorCode: ErrorCode | null): void {
    task.state = state;
    task.errorCode = errorCode;
    task.finishedAt = (this.deps.now ?? Date.now)();
    if (state !== 'succeeded') {
      task.partialText = '';
    }
    this.releaseSlot(task.requestId);
    this.releaseUsage(task.requestId);
    this.deps.onUpdate(task);
    this.pruneTasks();
  }

  private releaseSlot(requestId: string): void {
    if (this.activeRequestId === requestId) {
      this.activeRequestId = null;
      this.activeReaderKey = null;
    }
  }

  private finishImmediately(
    task: TranslationTask,
    state: TranslationTask['state'],
    errorCode: ErrorCode | null,
    now: () => number,
  ): TranslationTask {
    task.state = state;
    task.errorCode = errorCode;
    task.finishedAt = now();
    this.tasks.set(task.requestId, task);
    this.deps.onUpdate(task);
    this.pruneTasks();
    return task;
  }

  /**
   * Drops the oldest terminal records once the bound is exceeded. The active
   * request and its record are never removed.
   */
  private pruneTasks(): void {
    if (this.tasks.size <= MAX_TASK_RECORDS) return;
    for (const [requestId, task] of this.tasks) {
      if (this.tasks.size <= MAX_TASK_RECORDS) break;
      if (requestId === this.activeRequestId) continue;
      if (task.state === 'succeeded' || task.state === 'failed' || task.state === 'cancelled') {
        this.tasks.delete(requestId);
      }
    }
  }
}

function normalizeErrorCode(error: unknown): ErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (isKnownErrorCode(message)) {
    return message as ErrorCode;
  }
  return 'ENGINE_CRASHED';
}
