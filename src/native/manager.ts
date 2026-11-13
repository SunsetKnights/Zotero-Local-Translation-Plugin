import {
  PROTOCOL_VERSION,
  TARGET_LANGUAGE,
  type ErrorCode,
  type IncomingFrame,
  type ReadyInfo,
} from '../../shared/types';
import { encodeFrame, FrameTooLargeError, LineDecoder } from './jsonl';
import type { ModelParameters } from '../../shared/model-config';

export interface HostConfig {
  helperPath: string;
  modelPath: string;
  /** Accepted for old callers only; never sent or verified. */
  modelSha256?: string;
  modelParameters?: ModelParameters;
  allowCpuFallback?: boolean;
  contextTokens: number;
  threads: number;
  /**
   * Effective idle release threshold. `<= 0` disables the idle timer entirely;
   * the settings layer passes 0 while the user's opt-in switch is off.
   */
  idleReleaseMs: number;
  /** < 0 offloads every layer, 0 keeps inference on the CPU. */
  gpuLayers: number;
}

/** Minimal process surface so the manager can be tested without Zotero. */
export interface HostProcess {
  write(chunk: Uint8Array): Promise<void> | void;
  /** Resolves with the next chunk, or null at EOF. */
  read(): Promise<Uint8Array | null>;
  readStderr(): Promise<Uint8Array | null>;
  closeStdin(): Promise<void> | void;
  wait(): Promise<{ exitCode: number | null }>;
  kill(): Promise<{ exitCode: number | null }>;
}

export interface ProcessSpawner {
  spawn(command: string, args: string[]): Promise<HostProcess>;
}

export interface TranslationHandlers {
  onStarted?(inputTokens: number): void;
  onDelta?(seq: number, text: string): void;
  onSuccess?(text: string, meta: { outputTokens: number; truncated: boolean; timingMs?: { prefill: number; generation: number } }): void;
  onError?(code: ErrorCode, retryable: boolean, detail?: string): void;
  onCancelled?(): void;
}

export interface ManagerLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export interface ManagerOptions {
  spawner: ProcessSpawner;
  getConfig(): HostConfig;
  getParentPid(): number;
  logger: ManagerLogger;
  initTimeoutMs?: number;
  translateTimeoutMs?: number;
  cancelTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  heartbeatMs?: number;
  heartbeatReplyMs?: number;
}

export type ManagerState = 'stopped' | 'starting' | 'ready' | 'stopping';

/** Coarse state shown in the settings window. */
export type ModelStatusKind = 'not-loaded' | 'loading' | 'ready' | 'busy' | 'releasing';

/**
 * A task's right to use the loaded model. It is taken *before* asset
 * preparation and the load start, so a manual release cannot interleave with a
 * request that has not reached `translate()` yet.
 */
export interface ModelUsage {
  readonly requestId: string;
  /** False once the request became active (the process terminal now owns it). */
  readonly held: boolean;
  release(): void;
}

export type ReleaseStatus = 'released' | 'not-loaded' | 'busy' | 'failed' | 'disposed';

export interface ReleaseResult {
  status: ReleaseStatus;
  /** True when this call (or the concurrent call it joined) closed a helper. */
  closed: boolean;
  graceful: boolean | null;
  durationMs: number;
  state: ManagerState;
  usageCount: number;
  activeRequestId: string | null;
  detail?: string;
  error?: string;
}

export interface RestartResult {
  status: 'restarted' | 'busy' | 'failed';
  detail?: string;
}

export interface ManagerStatus {
  state: ManagerState;
  ready: boolean;
  activeRequestId: string | null;
  usageCount: number;
  releasing: boolean;
  closeReason: CloseReason | null;
  idleTimerArmed: boolean;
  idleReleaseMs: number;
  sessionId: string | null;
  pendingConfigChange: boolean;
}

type CloseReason = 'manual' | 'idle' | 'settings' | 'restart' | 'shutdown' | 'dispose';

interface CloseOutcome {
  closed: boolean;
  graceful: boolean | null;
  durationMs: number;
  error?: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve };
}

type Settled<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'timeout' };

/** Awaits a promise with a bounded wait and always clears its timer. */
function settleWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<Settled<T>> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (outcome: Settled<T>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
    promise.then(
      (value) => finish({ status: 'fulfilled', value }),
      (reason: unknown) => finish({ status: 'rejected', reason }),
    );
  });
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error);
  return text && text !== 'undefined' ? text : fallback;
}

interface ActiveRequest {
  id: string;
  handlers: TranslationHandlers;
  timer: ReturnType<typeof setTimeout> | null;
  /** A terminal state was already delivered to the caller (timeout path). */
  reported: boolean;
  settled: Deferred<void>;
  cancelInFlight: Promise<boolean> | null;
}

interface PingWaiter {
  resolve(ok: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

interface InitWaiter {
  resolve(info: ReadyInfo): void;
  reject(error: Error): void;
}

interface Session {
  readonly id: string;
  readonly generation: number;
  readonly process: HostProcess;
  readonly decoder: LineDecoder;
  readyInfo: ReadyInfo | null;
  init: InitWaiter | null;
  active: ActiveRequest | null;
  closed: boolean;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatMisses: number;
  pingWaiters: Map<string, PingWaiter>;
  ackWaiters: Map<string, (frame: IncomingFrame | null) => void>;
  readLoop: Promise<void> | null;
}

const DEFAULTS = {
  initTimeoutMs: 120_000,
  translateTimeoutMs: 120_000,
  cancelTimeoutMs: 2_000,
  shutdownTimeoutMs: 3_000,
  heartbeatMs: 10_000,
  heartbeatReplyMs: 3_000,
};

export class NativeHostManager {
  private state: ManagerState = 'stopped';
  private session: Session | null = null;
  private readyInfo: ReadyInfo | null = null;
  private startPromise: Promise<ReadyInfo> | null = null;
  private closePromise: Promise<CloseOutcome> | null = null;
  private closeReason: CloseReason | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUsage = new Set<string>();
  private disposed = false;
  private generation = 0;
  private pendingConfigChange = false;
  private configRevision = 0;
  private lastIdleReleaseMs = 0;

  constructor(private readonly options: ManagerOptions) {}

  get isReady(): boolean {
    return !this.disposed && this.state === 'ready' && this.session !== null
      && !this.session.closed && this.session.readyInfo !== null;
  }

  get info(): ReadyInfo | null {
    return this.session?.readyInfo ?? this.readyInfo;
  }

  get busy(): boolean {
    return this.session?.active != null;
  }

  get usageCount(): number {
    return this.pendingUsage.size + (this.session?.active ? 1 : 0);
  }

  get status(): ManagerStatus {
    return {
      state: this.state,
      ready: this.isReady,
      activeRequestId: this.session?.active?.id ?? null,
      usageCount: this.usageCount,
      releasing: this.closePromise !== null && (this.closeReason === 'manual' || this.closeReason === 'idle'),
      closeReason: this.closeReason,
      idleTimerArmed: this.idleTimer !== null,
      idleReleaseMs: this.readIdleConfig(),
      sessionId: this.session?.id ?? null,
      pendingConfigChange: this.pendingConfigChange,
    };
  }

  /**
   * Takes the model usage right for a task. Call this before `ensureReady()`:
   * the lease covers asset preparation, the load and the handshake.
   */
  acquireUsage(requestId: string): ModelUsage {
    if (this.disposed) throw new Error('ENGINE_START_FAILED');
    this.pendingUsage.add(requestId);
    // A new task means the model is about to be used again: do not let an
    // already scheduled idle release race with it.
    this.clearIdleTimer();
    const isHeld = () => this.pendingUsage.has(requestId);
    return {
      requestId,
      get held() {
        return isHeld();
      },
      release: () => {
        this.releaseUsage(requestId);
      },
    };
  }

  private releaseUsage(requestId: string): void {
    if (!this.pendingUsage.delete(requestId)) return;
    this.afterUsageReleased();
  }

  async ensureReady(): Promise<ReadyInfo> {
    for (;;) {
      if (this.disposed) throw new Error('ENGINE_START_FAILED');
      if (this.state === 'ready' && this.session && !this.session.closed && this.session.readyInfo) {
        // Merely querying readiness must not extend the idle lifetime.
        // A translation acquires usage separately before preparing its input.
        return this.session.readyInfo;
      }
      if (this.closePromise) {
        // A release/restart is in flight. Wait for the actual process exit;
        // never spawn a replacement before it happened.
        await this.closePromise.catch(() => undefined);
        continue;
      }
      if (this.startPromise) {
        // The start promise is created before spawn, so every concurrent caller
        // joins the same handshake and all of them settle together.
        return this.startPromise;
      }
      return this.beginStart();
    }
  }

  private beginStart(): Promise<ReadyInfo> {
    this.state = 'starting';
    const promise = this.startInternal();
    this.startPromise = promise;
    const clear = () => {
      if (this.startPromise === promise) this.startPromise = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  private async startInternal(): Promise<ReadyInfo> {
    const config = this.options.getConfig();
    // Settings recorded before this load are applied by it; a change that
    // arrives while the load is running still needs a later retirement.
    const configRevisionAtStart = this.configRevision;
    const generation = ++this.generation;
    const sessionId = randomId('s');
    this.readyInfo = null;

    let proc: HostProcess;
    try {
      proc = await this.options.spawner.spawn(config.helperPath, [
        '--parent-pid',
        String(this.options.getParentPid()),
        '--context',
        String(config.contextTokens),
        '--threads',
        String(config.threads),
        '--gpu-layers',
        String(config.gpuLayers),
      ]);
    }
    catch {
      if (this.state === 'starting') this.state = 'stopped';
      throw new Error('ENGINE_START_FAILED');
    }

    if (this.disposed) {
      // dispose() ran while the spawn was in flight: never revive the process.
      await Promise.resolve(proc.kill()).catch(() => undefined);
      if (this.state === 'starting') this.state = 'stopped';
      throw new Error('ENGINE_START_FAILED');
    }

    const session: Session = {
      id: sessionId,
      generation,
      process: proc,
      decoder: new LineDecoder(),
      readyInfo: null,
      init: null,
      active: null,
      closed: false,
      heartbeatTimer: null,
      heartbeatMisses: 0,
      pingWaiters: new Map(),
      ackWaiters: new Map(),
      readLoop: null,
    };
    this.session = session;
    session.readLoop = this.runReadLoop(session);
    void this.pumpStderr(session);

    let resolveInit!: (info: ReadyInfo) => void;
    let rejectInit!: (error: Error) => void;
    const initPromise = new Promise<ReadyInfo>((resolve, reject) => {
      resolveInit = resolve;
      rejectInit = reject;
    });
    session.init = { resolve: resolveInit, reject: rejectInit };
    try {
      this.writeTo(session, {
        v: PROTOCOL_VERSION,
        sessionId: session.id,
        id: 'init-1',
        type: 'init',
        modelPath: config.modelPath,
        modelParameters: config.modelParameters,
        allowCpuFallback: config.allowCpuFallback,
        gpuLayers: config.gpuLayers,
        contextTokens: config.contextTokens,
        threads: config.threads,
      });
    }
    catch (error) {
      await this.terminate(session, 'init write failed');
      throw new Error(errorMessage(error, 'ENGINE_START_FAILED'));
    }

    const timeoutMs = this.options.initTimeoutMs ?? DEFAULTS.initTimeoutMs;
    const outcome = await settleWithTimeout(initPromise, timeoutMs);
    if (outcome.status === 'timeout') {
      await this.terminate(session, 'init timeout');
      throw new Error('ENGINE_TIMEOUT');
    }
    if (outcome.status === 'rejected') {
      await this.terminate(session, 'init failure');
      throw new Error(errorMessage(outcome.reason, 'ENGINE_START_FAILED'));
    }
    if (this.disposed || this.session !== session || session.closed) {
      await this.terminate(session, 'disposed during init');
      throw new Error('ENGINE_START_FAILED');
    }
    this.readyInfo = outcome.value;
    this.state = 'ready';
    if (this.configRevision === configRevisionAtStart) {
      // This instance was loaded with the current settings.
      this.pendingConfigChange = false;
    }
    this.startHeartbeat(session);
    this.options.logger.debug(
      `native host ready: engine=${outcome.value.engineCommit} ctx=${outcome.value.contextTokens} threads=${outcome.value.threads} session=${session.id}`,
    );

    if (this.pendingConfigChange && this.pendingUsage.size === 0 && !session.active) {
      // Settings changed while this load was in flight: keep the result usable
      // for a request that is already waiting (it holds a usage lease), but
      // retire the instance as soon as it is idle.
      if (this.usageCount === 0) {
        void this.beginClose('settings').catch(() => undefined);
      }
    }
    else {
      this.armIdleTimer();
    }
    return outcome.value;
  }

  async translate(
    text: string,
    handlers: TranslationHandlers,
    requestId?: string,
  ): Promise<string> {
    if (this.disposed) throw new Error('ENGINE_START_FAILED');
    const session = this.session;
    if (this.closePromise || this.state !== 'ready' || !session || session.closed || !session.readyInfo) {
      throw new Error('ENGINE_START_FAILED');
    }
    if (session.active) {
      throw new Error('ENGINE_BUSY');
    }
    this.clearIdleTimer();
    // The caller's id is used verbatim so cancel() can address the same request.
    const id = requestId ?? randomId('t');
    // The preparation lease turns into the active request's usage right.
    this.pendingUsage.delete(id);
    const request: ActiveRequest = {
      id,
      handlers,
      timer: null,
      reported: false,
      settled: defer<void>(),
      cancelInFlight: null,
    };
    session.active = request;

    const timeout = this.options.translateTimeoutMs ?? DEFAULTS.translateTimeoutMs;
    request.timer = setTimeout(() => {
      if (this.session !== session || session.active !== request) return;
      // Settle the user task exactly once, but keep tracking the native request:
      // the engine is not idle until its terminal frame or process recovery.
      this.reportError(request, 'ENGINE_TIMEOUT', true, 'client timeout');
      void this.cancelInternal(session, request, 'timeout').catch(() => undefined);
    }, timeout);

    this.writeTo(session, {
      v: PROTOCOL_VERSION,
      sessionId: session.id,
      id,
      type: 'translate',
      text,
      targetLanguage: TARGET_LANGUAGE,
    });
    return id;
  }

  /**
   * Requests cooperative cancellation and resolves only after the task reached
   * its native terminal state (or the unhealthy process was reclaimed). A cancel
   * ack on its own is not completion.
   */
  async cancel(requestId: string): Promise<boolean> {
    const session = this.session;
    if (!session || session.closed) return false;
    const request = session.active;
    if (!request || request.id !== requestId) return false;
    return this.cancelInternal(session, request, 'user');
  }

  private async cancelInternal(
    session: Session,
    request: ActiveRequest,
    reason: 'user' | 'timeout',
  ): Promise<boolean> {
    if (session.active !== request) return true;
    if (request.cancelInFlight) return request.cancelInFlight;

    const promise = this.doCancel(session, request, reason);
    request.cancelInFlight = promise;
    try {
      return await promise;
    }
    finally {
      if (request.cancelInFlight === promise) request.cancelInFlight = null;
    }
  }

  private async doCancel(
    session: Session,
    request: ActiveRequest,
    reason: 'user' | 'timeout',
  ): Promise<boolean> {
    if (session.active !== request) return true;
    const timeoutMs = this.options.cancelTimeoutMs ?? DEFAULTS.cancelTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;

    // The helper answers `already-finished` while the translate frame may still
    // be queued behind its stdin thread. Waiting only for a terminal would then
    // time out and reclaim a healthy process, so a short grace period is
    // followed by another cancel attempt within the same budget.
    while (session.active === request && Date.now() < deadline && attempts < 3) {
      attempts += 1;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const ackWaitMs = attempts === 1 ? Math.min(750, remaining) : remaining;
      const ack = await this.requestCancel(session, request, ackWaitMs);
      if (!ack) {
        // No acknowledgement: the helper cannot unwind cooperatively.
        break;
      }
      if (ack.outcome === 'accepted') break;
      const grace = Math.min(deadline - Date.now(), attempts === 1 ? 100 : 250);
      if (grace > 0) {
        const settled = await settleWithTimeout(request.settled.promise, grace);
        if (settled.status !== 'timeout') return true;
      }
    }

    if (session.active !== request) return true;
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      // Cover "ack accepted but the terminal frame never arrives".
      const settled = await settleWithTimeout(request.settled.promise, remaining);
      if (settled.status !== 'timeout') return true;
    }
    await this.terminate(session, `cancel ${reason}: no terminal frame`);
    return false;
  }

  /** Sends one cancel frame and waits for its ack with a bounded timer. */
  private async requestCancel(
    session: Session,
    request: ActiveRequest,
    timeoutMs: number,
  ): Promise<{ outcome: string } | null> {
    const ack = defer<IncomingFrame | null>();
    session.ackWaiters.set(request.id, ack.resolve);
    const timer = setTimeout(() => {
      const waiter = session.ackWaiters.get(request.id);
      if (!waiter) return;
      session.ackWaiters.delete(request.id);
      waiter(null);
    }, timeoutMs);
    try {
      try {
        this.writeTo(session, {
          v: PROTOCOL_VERSION,
          sessionId: session.id,
          id: randomId('c'),
          type: 'cancel',
          targetId: request.id,
        });
      }
      catch {
        return null;
      }
      const frame = await ack.promise;
      if (!frame || frame.type !== 'ack') return null;
      return { outcome: frame.outcome };
    }
    finally {
      clearTimeout(timer);
      session.ackWaiters.delete(request.id);
    }
  }

  /**
   * Closes the helper process and waits for its real exit. This is not
   * `dispose()`: the next `ensureReady()` loads the model again.
   */
  async releaseModel(): Promise<ReleaseResult> {
    const startedAt = Date.now();
    const base = (): Omit<ReleaseResult, 'status'> => ({
      closed: false,
      graceful: null,
      durationMs: 0,
      state: this.state,
      usageCount: this.usageCount,
      activeRequestId: this.session?.active?.id ?? null,
    });

    if (this.disposed) {
      return { ...base(), status: 'disposed', detail: 'plugin is shutting down' };
    }
    if (this.closePromise) {
      // A release (manual or idle) is already in flight: join it instead of
      // starting a second close or a spawn.
      const outcome = await this.closePromise.catch(() => null);
      return {
        ...base(),
        status: outcome && outcome.closed ? 'released' : 'not-loaded',
        closed: outcome?.closed ?? false,
        graceful: outcome?.graceful ?? null,
        durationMs: outcome?.durationMs ?? Date.now() - startedAt,
        error: outcome?.error,
      };
    }
    if (this.state === 'starting') {
      return { ...base(), status: 'busy', detail: 'model is loading' };
    }
    if (this.state !== 'ready' || !this.session) {
      return { ...base(), status: 'not-loaded' };
    }
    if (this.session.active || this.pendingUsage.size > 0) {
      return { ...base(), status: 'busy', detail: 'a task is using the model' };
    }

    // The check and the transition to `stopping` happen in one synchronous
    // block, so a task cannot slip in between "idle" and "closing".
    const outcome = await this.beginClose('manual');
    return {
      ...base(),
      status: outcome.error ? 'failed' : outcome.closed ? 'released' : 'not-loaded',
      closed: outcome.closed,
      graceful: outcome.graceful,
      durationMs: outcome.durationMs,
      error: outcome.error,
    };
  }

  /** Explicit user restart: close first, then load again. */
  async restart(): Promise<RestartResult> {
    if (this.disposed) return { status: 'failed', detail: 'plugin is shutting down' };
    if (this.closePromise) {
      await this.closePromise.catch(() => undefined);
    }
    if (this.state === 'starting') return { status: 'busy', detail: 'model is loading' };
    if (this.session?.active || this.pendingUsage.size > 0) {
      return { status: 'busy', detail: 'a task is using the model' };
    }
    this.pendingConfigChange = false;
    const outcome = await this.beginClose('restart');
    if (outcome.error) return { status: 'failed', detail: outcome.error };
    try {
      await this.ensureReady();
      return { status: 'restarted' };
    }
    catch (error) {
      return { status: 'failed', detail: errorMessage(error, 'ENGINE_START_FAILED') };
    }
  }

  /**
   * Applies a new idle policy (switch or threshold) without loading or
   * restarting anything. A loaded, idle model starts counting from now; a busy
   * one arms the timer when it actually becomes idle.
   */
  refreshPolicy(): void {
    if (this.state === 'ready') {
      this.afterUsageReleased();
    }
    else {
      this.clearIdleTimer();
    }
  }

  /**
   * Records that threads/GPU settings changed. The current task is never
   * interrupted: an idle instance is retired now, a busy one as soon as its
   * usage ends. Nothing is reloaded until the next request.
   */
  applyConfigChange(): void {
    this.pendingConfigChange = true;
    this.configRevision += 1;
    this.clearIdleTimer();
    if (this.state !== 'ready' || !this.session) return;
    if (this.session.active || this.pendingUsage.size > 0) return;
    void this.beginClose('settings').catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    if (this.disposed) {
      await this.closePromise?.catch(() => undefined);
      return;
    }
    if (this.startPromise) {
      // A close requested during a start must cover that start; otherwise the
      // spawn could resolve afterwards and revive the process.
      await settleWithTimeout(
        this.startPromise.then(() => undefined, () => undefined),
        this.options.shutdownTimeoutMs ?? DEFAULTS.shutdownTimeoutMs,
      );
    }
    await this.beginClose('shutdown').catch(() => undefined);
  }

  /** Final close. No later `ensureReady` may spawn a new helper. */
  async dispose(): Promise<void> {
    const first = !this.disposed;
    this.disposed = true;
    this.clearIdleTimer();
    if (!first) {
      if (this.closePromise) await this.closePromise.catch(() => undefined);
      return;
    }
    const pendingStart = this.startPromise;
    if (pendingStart) {
      // Bounded wait: startInternal kills the process itself if the spawn
      // resolves after dispose() has been requested.
      await settleWithTimeout(
        pendingStart.then(() => undefined, () => undefined),
        this.options.shutdownTimeoutMs ?? DEFAULTS.shutdownTimeoutMs,
      );
    }
    await this.beginClose('dispose').catch(() => undefined);
    // The plugin instance is gone; no task can legitimately still own usage.
    this.pendingUsage.clear();
  }

  // --- closing --------------------------------------------------------------

  private beginClose(reason: CloseReason): Promise<CloseOutcome> {
    if (this.closePromise) return this.closePromise;
    const session = this.session;
    this.state = 'stopping';
    this.closeReason = reason;
    this.clearIdleTimer();

    const closePromise = this.doClose(session, reason)
      .catch((error: unknown): CloseOutcome => ({
        closed: true,
        graceful: false,
        durationMs: 0,
        error: errorMessage(error, 'close failed'),
      }))
      .finally(() => {
        if (this.closePromise === closePromise) {
          this.closePromise = null;
          this.closeReason = null;
        }
        if (this.state === 'stopping') this.state = 'stopped';
      });
    this.closePromise = closePromise;
    return closePromise;
  }

  private async doClose(session: Session | null, reason: CloseReason): Promise<CloseOutcome> {
    const startedAt = Date.now();
    if (!session) {
      this.state = 'stopped';
      return { closed: false, graceful: null, durationMs: Date.now() - startedAt };
    }

    let graceful: boolean | null = null;
    let error: string | undefined;
    try {
      this.writeTo(session, {
        v: PROTOCOL_VERSION,
        sessionId: session.id,
        id: randomId('bye'),
        type: 'shutdown',
      });
    }
    catch {
      // process already gone
    }
    try {
      await Promise.resolve(session.process.closeStdin());
    }
    catch {
      // ignore
    }

    const shutdownTimeoutMs = this.options.shutdownTimeoutMs ?? DEFAULTS.shutdownTimeoutMs;
    const exit = await settleWithTimeout(
      session.process.wait().then(() => true, () => true),
      shutdownTimeoutMs,
    );
    if (exit.status === 'fulfilled') {
      graceful = true;
    }
    else {
      // Cooperative shutdown did not finish in time: force the process down.
      graceful = false;
      try {
        await session.process.kill();
      }
      catch {
        // ignore
      }
      const afterKill = await settleWithTimeout(
        session.process.wait().then(() => true, () => true),
        1_000,
      );
      if (afterKill.status !== 'fulfilled') {
        error = 'helper did not exit after kill';
      }
    }

    // Only clear the current session if it is still this one; an old session's
    // late EOF must not touch a replacement process.
    const clearUsage = reason === 'dispose' || reason === 'shutdown';
    this.finalizeSession(session, reason, clearUsage);
    if (this.state === 'stopping') this.state = 'stopped';
    this.options.logger.debug(`native host closed: reason=${reason} graceful=${String(graceful)}`);
    return {
      closed: true,
      graceful,
      durationMs: Date.now() - startedAt,
      error,
    };
  }

  private async terminate(session: Session, reason: string): Promise<void> {
    if (session.closed && this.session !== session) return;
    try {
      await session.process.kill();
    }
    catch {
      // ignore
    }
    // The process is gone: every native usage right is void.
    this.finalizeSession(session, reason, true);
    if (!this.closePromise && this.state !== 'stopped') this.state = 'stopped';
    this.options.logger.warn(`native host stopped: ${reason}`);
  }

  private finalizeSession(session: Session, reason: string, clearUsage: boolean): void {
    const wasCurrent = this.session === session;
    session.closed = true;
    this.stopHeartbeat(session);

    if (session.init) {
      const init = session.init;
      session.init = null;
      init.reject(new Error('ENGINE_CRASHED'));
    }
    for (const resolve of [...session.ackWaiters.values()]) {
      resolve(null);
    }
    session.ackWaiters.clear();

    const active = session.active;
    if (active) {
      session.active = null;
      if (active.timer) clearTimeout(active.timer);
      if (!active.reported) {
        active.reported = true;
        try {
          active.handlers.onError?.('ENGINE_CRASHED', true, reason);
        }
        catch (error) {
          this.options.logger.warn(`task handler failed: ${String(error)}`);
        }
      }
      active.settled.resolve();
    }

    if (clearUsage) this.pendingUsage.clear();
    if (wasCurrent) {
      this.session = null;
      this.readyInfo = null;
    }
    this.clearIdleTimer();
  }

  // --- idle policy ----------------------------------------------------------

  private readIdleConfig(): number {
    try {
      return this.options.getConfig().idleReleaseMs;
    }
    catch {
      return 0;
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.disposed) return;
    if (this.state !== 'ready' || !this.session || this.session.closed) return;
    if (this.session.active || this.pendingUsage.size > 0 || this.closePromise) return;
    // Only a loaded model gets a timer; nothing is scheduled while stopped.
    const idleMs = this.readIdleConfig();
    this.lastIdleReleaseMs = idleMs;
    if (!(idleMs > 0)) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.onIdleTimer();
    }, idleMs);
  }

  private onIdleTimer(): void {
    if (this.disposed) return;
    if (this.state !== 'ready' || !this.session || this.session.closed) return;
    if (this.session.active || this.pendingUsage.size > 0 || this.closePromise) return;
    void this.beginClose('idle').catch(() => undefined);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private afterUsageReleased(): void {
    if (this.disposed) return;
    if (this.state !== 'ready' || !this.session || this.session.closed) return;
    if (this.session.active || this.pendingUsage.size > 0) {
      this.clearIdleTimer();
      return;
    }
    if (this.pendingConfigChange) {
      void this.beginClose('settings').catch(() => undefined);
      return;
    }
    this.armIdleTimer();
  }

  // --- process I/O ----------------------------------------------------------

  private async runReadLoop(session: Session): Promise<void> {
    try {
      for (;;) {
        const chunk = await session.process.read();
        if (!chunk) break;
        if (session.closed) break;
        for (const line of session.decoder.push(chunk)) {
          this.handleLine(session, line);
        }
      }
    }
    catch (error) {
      if (error instanceof FrameTooLargeError) {
        this.options.logger.warn('protocol frame too large; terminating session');
      }
      else {
        this.options.logger.warn(`protocol read failed: ${String(error)}`);
      }
    }
    // The reader ended. Only the process that is still current may be treated
    // as gone; a stale session must not terminate its replacement.
    if (session.closed || this.session !== session) return;
    if (this.closePromise) return;
    await this.terminate(session, 'stdout closed');
  }

  private async pumpStderr(session: Session): Promise<void> {
    try {
      for (;;) {
        const chunk = await session.process.readStderr();
        if (!chunk) return;
        const text = new TextDecoder('utf-8').decode(chunk);
        this.options.logger.warn(text.trim().slice(0, 500));
      }
    }
    catch {
      // stderr is diagnostic only
    }
  }

  private writeTo(session: Session | null, frame: Record<string, unknown>): void {
    if (!session || session.closed || this.session !== session) {
      throw new Error('ENGINE_CRASHED');
    }
    const bytes = encodeFrame(frame);
    const result = session.process.write(bytes);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      void (result as Promise<void>).catch((error: unknown) => {
        this.options.logger.warn(`protocol write failed: ${String(error)}`);
      });
    }
  }

  private handleLine(session: Session, line: string): void {
    if (session.closed || this.session !== session) {
      // A late frame from a process that was already replaced or disposed.
      if (!session.closed) this.options.logger.debug('ignoring frame from a stale session');
      return;
    }
    let frame: IncomingFrame;
    try {
      frame = JSON.parse(line) as IncomingFrame;
    }
    catch {
      this.options.logger.warn('dropping malformed protocol frame');
      return;
    }
    if (frame.v !== PROTOCOL_VERSION) {
      this.options.logger.warn(`unexpected protocol version ${String(frame.v)}`);
      return;
    }

    switch (frame.type) {
      case 'ready': {
        if (!session.init) {
          this.options.logger.debug('ignoring duplicate ready frame');
          break;
        }
        const waiter = session.init;
        session.init = null;
        session.readyInfo = {
          modelSha256: frame.modelSha256,
          engineCommit: frame.engineCommit,
          engineVersion: frame.engineVersion,
          buildId: frame.buildId,
          contextTokens: frame.contextTokens,
          threads: frame.threads,
          gpuLayers: frame.gpuLayers,
          gpuFallback: frame.gpuFallback,
          gpuOffloaded: frame.gpuOffloaded,
          devices: frame.devices,
          templateVersion: frame.templateVersion,
          maxInputTokens: frame.maxInputTokens,
          maxOutputTokens: frame.maxOutputTokens,
        };
        waiter.resolve(session.readyInfo);
        break;
      }
      case 'started': {
        const active = session.active;
        if (active?.id === frame.id && !active.reported) {
          this.safeHandler(() => active.handlers.onStarted?.(frame.inputTokens));
        }
        break;
      }
      case 'delta': {
        const active = session.active;
        if (active?.id === frame.id && !active.reported) {
          this.safeHandler(() => active.handlers.onDelta?.(frame.seq, frame.text));
        }
        break;
      }
      case 'result': {
        const active = session.active;
        if (active?.id !== frame.id) break;
        this.finishRequest(session, active, (handlers) => {
          handlers.onSuccess?.(frame.text, {
            outputTokens: frame.outputTokens,
            truncated: frame.truncated === true || frame.finishReason === 'length',
            timingMs: frame.timingMs,
          });
        });
        break;
      }
      case 'error': {
        const active = session.active;
        if (active?.id === frame.id) {
          this.finishRequest(session, active, (handlers) => {
            handlers.onError?.(frame.code as ErrorCode, frame.retryable, frame.detail);
          });
          break;
        }
        if (frame.id === 'init-1' && session.init) {
          const waiter = session.init;
          session.init = null;
          waiter.reject(new Error(frame.code));
          break;
        }
        if (frame.id === 'startup') {
          this.options.logger.warn(`helper startup failed: ${frame.code} ${frame.detail ?? ''}`);
        }
        break;
      }
      case 'cancelled': {
        const active = session.active;
        if (active?.id !== frame.id) break;
        this.finishRequest(session, active, (handlers) => {
          handlers.onCancelled?.();
        });
        break;
      }
      case 'ack': {
        const waiter = session.ackWaiters.get(frame.targetId);
        if (waiter) {
          session.ackWaiters.delete(frame.targetId);
          waiter(frame);
        }
        break;
      }
      case 'pong': {
        const waiter = session.pingWaiters.get(frame.id);
        if (waiter) {
          session.pingWaiters.delete(frame.id);
          clearTimeout(waiter.timer);
          waiter.resolve(true);
        }
        break;
      }
      default:
        break;
    }
  }

  private finishRequest(
    session: Session,
    request: ActiveRequest,
    deliver: (handlers: TranslationHandlers) => void,
  ): void {
    if (session.active !== request) return;
    session.active = null;
    if (request.timer) {
      clearTimeout(request.timer);
      request.timer = null;
    }
    if (!request.reported) {
      request.reported = true;
      this.safeHandler(() => deliver(request.handlers));
    }
    request.settled.resolve();
    this.afterUsageReleased();
  }

  private reportError(
    request: ActiveRequest,
    code: ErrorCode,
    retryable: boolean,
    detail?: string,
  ): void {
    if (request.reported) return;
    request.reported = true;
    this.safeHandler(() => request.handlers.onError?.(code, retryable, detail));
  }

  private safeHandler(run: () => void): void {
    try {
      run();
    }
    catch (error) {
      this.options.logger.warn(`task handler failed: ${String(error)}`);
    }
  }

  private startHeartbeat(session: Session): void {
    this.stopHeartbeat(session);
    const interval = this.options.heartbeatMs ?? DEFAULTS.heartbeatMs;
    const replyMs = this.options.heartbeatReplyMs ?? DEFAULTS.heartbeatReplyMs;
    session.heartbeatTimer = setInterval(() => {
      if (session.closed || this.session !== session) return;
      if (this.state !== 'ready' || !session.readyInfo) return;
      if (session.heartbeatMisses >= 3) {
        void this.terminate(session, 'heartbeat lost');
        return;
      }
      const id = randomId('p');
      const timer = setTimeout(() => {
        const waiter = session.pingWaiters.get(id);
        if (!waiter) return;
        session.pingWaiters.delete(id);
        waiter.resolve(false);
      }, replyMs);
      session.pingWaiters.set(id, {
        timer,
        resolve: (ok: boolean) => {
          clearTimeout(timer);
          if (ok) session.heartbeatMisses = 0;
          else session.heartbeatMisses += 1;
        },
      });
      try {
        this.writeTo(session, { v: PROTOCOL_VERSION, sessionId: session.id, id, type: 'ping' });
      }
      catch {
        const waiter = session.pingWaiters.get(id);
        if (waiter) {
          clearTimeout(waiter.timer);
          session.pingWaiters.delete(id);
        }
      }
    }, interval);
  }

  private stopHeartbeat(session: Session): void {
    if (session.heartbeatTimer) {
      clearInterval(session.heartbeatTimer);
      session.heartbeatTimer = null;
    }
    for (const waiter of session.pingWaiters.values()) {
      clearTimeout(waiter.timer);
    }
    session.pingWaiters.clear();
  }
}

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${hex}`;
}
