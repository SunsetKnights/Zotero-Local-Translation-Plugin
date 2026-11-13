import type { ModelMetadata, ModelProfile, ModelStore } from '../../shared/model-config';
import { validateProfile } from './model-config';

export interface TrialResult {
  status: 'gpu-ready' | 'cpu-ready' | 'cpu-fallback' | 'failed' | 'cancelled';
  gpuError?: string;
  error?: string;
}

export interface ModelSelectionDeps {
  makeAbortController?(): AbortController;
  getStore(): ModelStore;
  saveStore(store: ModelStore): void;
  isEngineBusy(): boolean;
  stopEngine(): Promise<void>;
  getDeviceConfig(): { runtimeBuildId: string };
  stat(path: string): Promise<{ size: number; lastModified: number }>;
  inspect(path: string, signal: AbortSignal): Promise<ModelMetadata>;
  trial(profile: ModelProfile, gpuLayers: number, signal: AbortSignal): Promise<void>;
}

function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

/** Stable comparison also accepts object properties reconstructed in a different order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).filter((key) => object[key] !== undefined).sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(object[key])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

/** Locks cover preparation and native cleanup. Saved revisions and the active
 * snapshot are separate: editing a configuration never changes a running model. */
export class ModelSelection {
  private operation: AbortController | null = null;
  private pending: Promise<unknown> | null = null;
  private verified: { key: string; result: TrialResult } | null = null;
  private disposed = false;
  phase = '';

  constructor(private readonly deps: ModelSelectionDeps) {}
  get locked(): boolean { return this.operation !== null; }
  get canChange(): boolean { return !this.disposed && !this.locked && !this.deps.isEngineBusy(); }

  private run<T>(phase: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.canChange) return Promise.reject(new Error('ENGINE_BUSY'));
    const controller = this.deps.makeAbortController?.() ?? new AbortController();
    this.operation = controller;
    this.phase = phase;
    const promise = action(controller.signal).finally(() => {
      this.operation = null;
      this.phase = '';
      this.pending = null;
    });
    this.pending = promise;
    return promise;
  }

  cancel(): void { this.operation?.abort(); this.verified = null; }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel();
    await this.pending?.catch(() => undefined);
  }

  private assertNotCancelled(signal: AbortSignal): void {
    if (signal.aborted || this.disposed) throw new Error('CANCELLED');
  }

  private editableRevision(candidate: ModelProfile, store: ModelStore): ModelProfile | undefined {
    const saved = store.profiles.find((profile) => profile.id === candidate.id);
    if (saved ? candidate.revision !== saved.revision : candidate.revision !== 0) throw new Error('MODEL_CHANGED');
    return saved;
  }

  private validate(candidate: ModelProfile): void {
    const issues = validateProfile(candidate);
    if (issues.length) throw new Error(issues.map((issue) => issue.message).join('\n'));
  }

  /** Saves only the editable record. It neither stops nor loads an engine. */
  save(profile: ModelProfile): Promise<ModelProfile> {
    const candidate = copy(profile);
    return this.run('正在保存配置…', async (signal) => {
      this.verified = null;
      if (typeof candidate.name === 'string') candidate.name = candidate.name.trim();
      if (typeof candidate.path === 'string') {
        candidate.path = candidate.path.trim().replace(/^"(.*)"$/, '$1').replace(/\//g, '\\');
      }
      // Validate before IO, but do not use metadata from a previous model path.
      this.validate({ ...candidate, metadata: undefined });
      const existing = this.editableRevision(candidate, this.deps.getStore());
      const existingSnapshot = existing ? canonical(existing) : null;
      const stat = await this.deps.stat(candidate.path);
      this.assertNotCancelled(signal);
      const needsInspection = !existing || existing.path !== candidate.path || !existing.metadata
        || existing.fileSize !== stat.size || existing.lastModified !== stat.lastModified;
      candidate.metadata = needsInspection
        ? await this.deps.inspect(candidate.path, signal)
        : copy(existing.metadata!);
      this.assertNotCancelled(signal);
      const after = await this.deps.stat(candidate.path);
      this.assertNotCancelled(signal);
      if (stat.size !== after.size || stat.lastModified !== after.lastModified) throw new Error('MODEL_CHANGED');
      candidate.fileSize = stat.size;
      candidate.lastModified = stat.lastModified;
      this.validate(candidate);
      const store = this.deps.getStore();
      const latest = this.editableRevision(candidate, store);
      if ((latest ? canonical(latest) : null) !== existingSnapshot) throw new Error('MODEL_CHANGED');
      if (store.profiles.some((saved) => saved.id !== candidate.id && saved.name.toLowerCase() === candidate.name.toLowerCase())) {
        throw new Error('此配置名称已存在，请使用其他名称。');
      }
      candidate.revision = (latest?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(candidate.revision)) throw new Error('MODEL_CONFIG_INVALID');
      const next = copy(store);
      const index = next.profiles.findIndex((saved) => saved.id === candidate.id);
      if (index < 0) next.profiles.push(copy(candidate));
      else next.profiles[index] = copy(candidate);
      this.deps.saveStore(next);
      return copy(candidate);
    });
  }

  /** Deletes the configuration record only. No model-file operations occur. */
  remove(id: string): Promise<void> {
    return this.run('正在删除配置…', async () => {
      const store = this.deps.getStore();
      if (store.activeId === id) throw new Error('正在使用的配置不能删除，请先切换到其他配置。');
      if (!store.profiles.some((profile) => profile.id === id)) throw new Error('MODEL_NOT_FOUND');
      const next = copy(store);
      next.profiles = next.profiles.filter((profile) => profile.id !== id);
      this.deps.saveStore(next);
      this.verified = null;
    });
  }

  private assertSaved(candidate: ModelProfile): void {
    const saved = this.deps.getStore().profiles.find((profile) => profile.id === candidate.id);
    if (!saved || candidate.revision < 1) throw new Error('请先保存当前配置，再切换使用。');
    if (canonical(saved) !== canonical(candidate)) throw new Error('MODEL_CHANGED');
  }

  private key(profile: ModelProfile): string {
    return canonical({ profile, runtimeBuildId: this.deps.getDeviceConfig().runtimeBuildId });
  }

  private async unchanged(profile: ModelProfile): Promise<void> {
    const stat = await this.deps.stat(profile.path);
    if (stat.size !== profile.fileSize || stat.lastModified !== profile.lastModified) throw new Error('MODEL_CHANGED');
  }

  test(profile: ModelProfile): Promise<TrialResult> {
    const candidate = copy(profile);
    return this.run('正在检测配置…', async (signal) => {
      this.verified = null;
      this.assertSaved(candidate);
      this.validate(candidate);
      const key = this.key(candidate);
      await this.unchanged(candidate);
      this.assertNotCancelled(signal);
      // Release old allocations before trying a new model: no double VRAM use.
      await this.deps.stopEngine();
      this.assertNotCancelled(signal);
      this.assertSaved(candidate);
      let gpuError: string | undefined;
      try {
        let result: TrialResult;
        if (candidate.device.useGpu) {
          this.phase = '正在检测 GPU 加速…';
          try {
            await this.deps.trial(candidate, candidate.device.gpuLayers, signal);
            result = { status: 'gpu-ready' };
          }
          catch (error) {
            this.assertNotCancelled(signal);
            gpuError = message(error);
            this.phase = 'GPU 检测未通过，正在检测 CPU…';
            await this.deps.trial(candidate, 0, signal);
            result = { status: 'cpu-fallback', gpuError };
          }
        }
        else {
          this.phase = '正在检测 CPU（未检测 GPU）…';
          await this.deps.trial(candidate, 0, signal);
          result = { status: 'cpu-ready' };
        }
        this.assertNotCancelled(signal);
        await this.unchanged(candidate);
        this.assertNotCancelled(signal);
        this.assertSaved(candidate);
        if (key !== this.key(candidate)) throw new Error('MODEL_CHANGED');
        this.verified = { key, result };
        return result;
      }
      catch (error) {
        return { status: signal.aborted ? 'cancelled' : 'failed', error: message(error), ...(gpuError ? { gpuError } : {}) };
      }
    });
  }

  /** Activation writes one complete snapshot. Future saves to the same ID do
   * not change this snapshot, even after Zotero or the native helper restarts. */
  apply(profile: ModelProfile, useCpu: boolean): Promise<void> {
    const candidate = copy(profile);
    return this.run('正在切换配置…', async (signal) => {
      this.assertSaved(candidate);
      const verified = this.verified;
      if (!verified || verified.key !== this.key(candidate)) throw new Error('请先检测当前配置。');
      if (verified.result.status === 'cpu-fallback' && !useCpu) throw new Error('GPU 检测未通过，请选择“以 CPU 使用”。');
      if (verified.result.status === 'gpu-ready' && useCpu) throw new Error('CPU 尚未检测，请关闭 GPU 后重新检测。');
      await this.unchanged(candidate);
      this.assertNotCancelled(signal);
      await this.deps.stopEngine();
      this.assertNotCancelled(signal);
      await this.unchanged(candidate);
      this.assertNotCancelled(signal);
      this.assertSaved(candidate);
      if (verified.key !== this.key(candidate)) throw new Error('MODEL_CHANGED');
      const activeProfile = copy(candidate);
      activeProfile.device.useGpu = verified.result.status === 'gpu-ready';
      const next = copy(this.deps.getStore());
      next.activeId = activeProfile.id;
      next.activeProfile = activeProfile;
      this.deps.saveStore(next);
      this.verified = null;
    });
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
