export const PREFIX = 'extensions.zotero.localTranslation.';

/** The UI exposes 1–60 minutes; the stored value is kept in that range. */
export const IDLE_RELEASE_MIN_MS = 30_000;
export const IDLE_RELEASE_MAX_MS = 60 * 60 * 1000;
/** Threshold used by older versions. Kept as the value for the optional feature. */
export const IDLE_RELEASE_DEFAULT_MS = 5 * 60 * 1000;

export interface Settings {
  threads: number;
  /**
   * Positive idle threshold in ms. It only has an effect when
   * `autoReleaseModel` is true; the manager receives 0 otherwise.
   */
  idleReleaseMs: number;
  /**
   * Explicit opt-in for releasing the model after an idle period. Defaults to
   * false: the model stays loaded until Zotero exits or the user releases it.
   */
  autoReleaseModel: boolean;
  /** Offload to the Vulkan backend when the device is available. */
  useGpu: boolean;
  /** -1 uses all layers; positive values allow partial GPU offload. */
  gpuLayers: number;
}

export const DEFAULTS: Settings = {
  threads: 4,
  idleReleaseMs: IDLE_RELEASE_DEFAULT_MS,
  autoReleaseModel: false,
  useGpu: true,
  gpuLayers: -1,
};

/** Read-only preference surface so the migration rules can be unit tested. */
export interface PrefReader {
  get<T>(name: string): T | undefined;
}

export interface ReadSettingsOptions {
  prefs?: PrefReader;
  logicalCpus?: number;
}

const zoteroPrefReader: PrefReader = {
  get<T>(name: string): T | undefined {
    try {
      return Zotero.Prefs.get(name, true) as T | undefined;
    }
    catch {
      return undefined;
    }
  },
};

function detectLogicalCpus(): number {
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    return navigator.hardwareConcurrency;
  }
  return 8;
}

export function readSettings(options: ReadSettingsOptions = {}): Settings {
  const prefs = options.prefs ?? zoteroPrefReader;
  const logical = Math.max(1, Math.min(8, options.logicalCpus ?? detectLogicalCpus()));

  const threads = prefs.get<number>(PREFIX + 'threads');
  const idle = prefs.get<number>(PREFIX + 'idleReleaseMs');
  const autoRelease = prefs.get<boolean>(PREFIX + 'autoReleaseModel');
  const useGpu = prefs.get<boolean>(PREFIX + 'useGpu');
  const gpuLayers = Number(prefs.get<number>(PREFIX + 'gpuLayers') ?? -1);

  return {
    threads: clamp(Number(threads ?? DEFAULTS.threads), 1, logical),
    idleReleaseMs: idle === undefined
      ? IDLE_RELEASE_DEFAULT_MS
      : clamp(Number(idle), IDLE_RELEASE_MIN_MS, IDLE_RELEASE_MAX_MS),
    // Only an explicit boolean true opts in. The positive idle threshold that an
    // older version may have stored must never turn the switch on by itself.
    autoReleaseModel: autoRelease === true,
    useGpu: useGpu === undefined ? DEFAULTS.useGpu : useGpu === true,
    gpuLayers: Number.isInteger(gpuLayers) && (gpuLayers === -1 || (gpuLayers >= 1 && gpuLayers <= 999)) ? gpuLayers : -1,
  };
}

/**
 * Value handed to NativeHostManager. 0 means "never release because of
 * idleness" and is the documented disabled value of the manager.
 */
export function effectiveIdleReleaseMs(
  settings: Pick<Settings, 'autoReleaseModel' | 'idleReleaseMs'>,
): number {
  if (settings.autoReleaseModel !== true) return 0;
  return clamp(settings.idleReleaseMs, IDLE_RELEASE_MIN_MS, IDLE_RELEASE_MAX_MS);
}

export function writeIdleReleaseMs(value: number): void {
  Zotero.Prefs.set(
    PREFIX + 'idleReleaseMs',
    clamp(Math.round(value), IDLE_RELEASE_MIN_MS, IDLE_RELEASE_MAX_MS),
    true,
  );
}

export function writeAutoReleaseModel(value: boolean): void {
  Zotero.Prefs.set(PREFIX + 'autoReleaseModel', value === true, true);
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
