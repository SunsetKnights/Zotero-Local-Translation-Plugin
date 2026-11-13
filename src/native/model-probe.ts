import type { ModelMetadata, ModelProfile } from '../../shared/model-config';
import { NativeHostManager, type HostConfig, type HostProcess, type ManagerLogger, type ProcessSpawner } from './manager';

/** The deadline covers spawning and pipe reads, not just a successful kill. */
function interruptible<T>(work: () => Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error !== null) reject(error);
      else resolve(result as T);
    };
    const abort = () => finish(new Error('CANCELLED'));
    const timer = setTimeout(() => finish(new Error('ENGINE_TIMEOUT')), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    // Both handlers remain attached if cancellation wins, so a late rejection
    // from a pipe or a failed spawn cannot become an unhandled rejection.
    void Promise.resolve().then(() => {
      if (settled) throw new Error('CANCELLED');
      return work();
    }).then((result) => finish(null, result), (error: unknown) => finish(error));
  });
}

/** A broken process adapter must not keep the settings window locked forever. */
function boundedCleanup(work: () => Promise<unknown>, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const finish = () => { clearTimeout(timer); resolve(); };
    void Promise.resolve().then(work).then(finish, finish);
  });
}

function killBounded(proc: HostProcess): Promise<void> {
  return boundedCleanup(() => proc.kill());
}

/** Metadata reads are isolated in the helper, bounded, and never load weights. */
export async function inspectModel(spawner: ProcessSpawner, helper: string, path: string, signal: AbortSignal): Promise<ModelMetadata> {
  if (signal.aborted) throw new Error('CANCELLED');
  let proc: HostProcess | null = null;
  let finished = false;
  try {
    return await interruptible(async () => {
      const spawned = await spawner.spawn(helper, ['--inspect-model', path]);
      if (finished) { void killBounded(spawned); throw new Error('CANCELLED'); }
      proc = spawned;
      void (async () => { while (!finished && await spawned.readStderr()) { /* drain diagnostics */ } })().catch(() => undefined);
      const decoder = new TextDecoder();
      let output = '';
      for (;;) {
        const chunk = await spawned.read();
        if (finished) throw new Error('CANCELLED');
        if (!chunk) break;
        output += decoder.decode(chunk, { stream: true });
        if (output.length > 2 * 1024 * 1024) throw new Error('MODEL_FORMAT_UNSUPPORTED');
      }
      output += decoder.decode();
      let result;
      try { result = JSON.parse(output.trim()); }
      catch { throw new Error('MODEL_FORMAT_UNSUPPORTED'); }
      if (result?.type === 'error') throw new Error(result.code || 'MODEL_FORMAT_UNSUPPORTED');
      if (result?.type !== 'model-info' || typeof result.architecture !== 'string' || !result.architecture.trim()) {
        throw new Error('MODEL_FORMAT_UNSUPPORTED');
      }
      if (result.splitCount > 1) throw new Error('MODEL_SPLIT_UNSUPPORTED');
      const exited = await spawned.wait();
      if (exited.exitCode !== 0) throw new Error('MODEL_FORMAT_UNSUPPORTED');
      return {
        name: String(result.name || ''), architecture: result.architecture,
        contextLength: Number(result.contextLength) || 0,
        chatTemplate: String(result.chatTemplate || ''),
        splitCount: Number(result.splitCount) || 1, fileType: Number(result.fileType) || 0,
      };
    }, signal, 30_000);
  }
  finally {
    finished = true;
    if (proc) await killBounded(proc);
  }
}

/** A trial never silently falls back to CPU and never shares the active model. */
export async function trialModel(options: {
  spawner: ProcessSpawner; config: HostConfig; profile: ModelProfile;
  parentPid: number; logger: ManagerLogger; signal: AbortSignal;
}): Promise<void> {
  const { signal, config } = options;
  if (signal.aborted) throw new Error('CANCELLED');
  let proc: HostProcess | null = null;
  let finished = false;
  const manager = new NativeHostManager({
    spawner: { spawn: async (command, args) => {
      const spawned = await options.spawner.spawn(command, args);
      if (finished) { void killBounded(spawned); throw new Error('CANCELLED'); }
      proc = spawned;
      return spawned;
    } },
    getConfig: () => ({ ...config, allowCpuFallback: false, idleReleaseMs: 0 }),
    getParentPid: () => options.parentPid, logger: options.logger,
  });
  try {
    await interruptible(async () => {
      const ready = await manager.ensureReady();
      if (signal.aborted || finished) throw new Error('CANCELLED');
      if (config.gpuLayers !== 0 && ready.gpuOffloaded !== true) throw new Error('GPU_UNAVAILABLE');
      await new Promise<void>((resolve, reject) => {
        void manager.translate('The treatment did not improve survival.', {
          onSuccess: (text, meta) => text.trim() && !meta.truncated ? resolve() : reject(new Error('EMPTY_OUTPUT')),
          onError: (code) => reject(new Error(code)),
          onCancelled: () => reject(new Error('CANCELLED')),
        }).catch(reject);
      });
    }, signal, 240_000);
  }
  finally {
    finished = true;
    const disposal = manager.dispose();
    if (proc) await killBounded(proc);
    await boundedCleanup(() => disposal);
  }
}
