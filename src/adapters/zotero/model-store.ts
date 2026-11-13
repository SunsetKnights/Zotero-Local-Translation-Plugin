import type { ModelDeviceSettings, ModelMetadata, ModelParameters, ModelProfile, ModelStore } from '../../../shared/model-config';
import { MAX_CHAT_TEMPLATE_LENGTH, defaultDeviceSettings, deriveProfileName, validateDevice, validateParameters } from '../../core/model-config';
import { PREFIX } from './prefs';

export const MODEL_STORE_PREF = PREFIX + 'modelProfiles';

export interface ModelStoreReader {
  get(name: string): unknown;
}

export interface ModelStoreWriter {
  set(name: string, value: string): void;
}

const defaultReader: ModelStoreReader = {
  get: (name) => Zotero.Prefs.get(name, true),
};

const defaultWriter: ModelStoreWriter = {
  set: (name, value) => Zotero.Prefs.set(name, value, true),
};

export function emptyModelStore(): ModelStore {
  return { version: 2, activeId: null, activeProfile: null, profiles: [] };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validText(value: unknown, max: number, empty = false): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0')
    && (empty || value.trim().length > 0);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function readMetadata(value: unknown): ModelMetadata | null {
  if (!object(value) || !validText(value.name, 4096, true)
    || !validText(value.architecture, 256)
    || !validText(value.chatTemplate, MAX_CHAT_TEMPLATE_LENGTH, true)
    || !nonnegativeInteger(value.contextLength)
    || !nonnegativeInteger(value.splitCount) || value.splitCount > 1
    || !nonnegativeInteger(value.fileType)) return null;
  return {
    name: value.name,
    architecture: value.architecture,
    contextLength: value.contextLength,
    chatTemplate: value.chatTemplate,
    splitCount: value.splitCount,
    fileType: value.fileType,
  };
}

function readParameters(value: unknown, metadata?: ModelMetadata): ModelParameters | null {
  if (!object(value)) return null;
  // Select the schema fields explicitly; never retain unknown stored properties.
  const parameters = {
    promptTemplate: value.promptTemplate,
    chatTemplate: value.chatTemplate,
    contextTokens: value.contextTokens,
    maxInputTokens: value.maxInputTokens,
    maxOutputTokens: value.maxOutputTokens,
    temperature: value.temperature,
    topP: value.topP,
    topK: value.topK,
    repeatPenalty: value.repeatPenalty,
    seed: value.seed,
  } as ModelParameters;
  return validateParameters(parameters, metadata).length === 0 ? parameters : null;
}

function readDevice(value: unknown): ModelDeviceSettings | null {
  if (!object(value)) return null;
  const device = { useGpu: value.useGpu, threads: value.threads, gpuLayers: value.gpuLayers } as ModelDeviceSettings;
  return validateDevice(device).length === 0 ? device : null;
}

function legacyDevice(prefs: ModelStoreReader, supplied?: ModelDeviceSettings): ModelDeviceSettings {
  if (supplied) return readDevice(supplied) ?? defaultDeviceSettings();
  const read = (key: string) => { try { return prefs.get(PREFIX + key); } catch { return undefined; } };
  const fallback = defaultDeviceSettings();
  const threads = read('threads');
  const gpuLayers = read('gpuLayers');
  const useGpu = read('useGpu');
  return {
    threads: typeof threads === 'number' && Number.isInteger(threads) && threads >= 1 && threads <= 8 ? threads : fallback.threads,
    gpuLayers: typeof gpuLayers === 'number' && Number.isInteger(gpuLayers)
      && (gpuLayers === -1 || (gpuLayers >= 1 && gpuLayers <= 999)) ? gpuLayers : fallback.gpuLayers,
    useGpu: typeof useGpu === 'boolean' ? useGpu : fallback.useGpu,
  };
}

function readProfile(value: unknown, migratedDevice?: ModelDeviceSettings): ModelProfile | null {
  if (!object(value) || !validText(value.id, 256) || !validText(value.path, 32768)
    || !/\.gguf$/i.test(value.path)
    || !(value.presetId === null || validText(value.presetId, 256))
    || !(value.presetVersion === null || (nonnegativeInteger(value.presetVersion) && value.presetVersion >= 1))
    || !nonnegativeInteger(value.fileSize) || !timestamp(value.lastModified)) return null;
  const metadata = value.metadata === undefined ? undefined : readMetadata(value.metadata);
  if (metadata === null) return null;
  const parameters = readParameters(value.parameters, metadata);
  if (!parameters) return null;
  const device = migratedDevice ? { ...migratedDevice } : readDevice(value.device);
  const name = migratedDevice ? deriveProfileName(value.path, metadata) : value.name;
  const revision = migratedDevice ? 1 : value.revision;
  if (!validText(name, 100) || !nonnegativeInteger(revision) || revision < 1 || !device) return null;
  return {
    id: value.id,
    name,
    revision,
    device,
    path: value.path,
    presetId: value.presetId,
    presetVersion: value.presetVersion,
    parameters,
    fileSize: value.fileSize,
    lastModified: value.lastModified,
    ...(metadata ? { metadata } : {}),
  };
}

/** A corrupt profile does not discard other usable model configurations. */
export function readModelStore(prefs: ModelStoreReader = defaultReader, defaultDevice?: ModelDeviceSettings): ModelStore {
  try {
    const text = prefs.get(MODEL_STORE_PREF);
    if (typeof text !== 'string' || !text) return emptyModelStore();
    const value: unknown = JSON.parse(text);
    if (!object(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.profiles)) return emptyModelStore();
    const migrating = value.version === 1;
    const device = migrating ? legacyDevice(prefs, defaultDevice) : undefined;
    const profiles: ModelProfile[] = [];
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const candidate of value.profiles) {
      const profile = readProfile(candidate, device);
      if (!profile || ids.has(profile.id)) continue;
      if (migrating) {
        const base = profile.name;
        let count = 2;
        while (names.has(profile.name.toLocaleLowerCase())) {
          const suffix = ` (${count++})`;
          profile.name = base.slice(0, 100 - suffix.length) + suffix;
        }
        names.add(profile.name.toLocaleLowerCase());
      }
      ids.add(profile.id);
      profiles.push(profile);
    }
    const saved = typeof value.activeId === 'string' ? profiles.find((profile) => profile.id === value.activeId) : undefined;
    // Version 2 must never substitute saved edits for a missing or invalid
    // activation snapshot, even if the id still exists in the profile list.
    const snapshot = migrating && saved
      ? readProfile(saved)
      : readProfile(value.activeProfile);
    const activeProfile = saved && snapshot?.id === saved.id && snapshot.revision <= saved.revision ? snapshot : null;
    return {
      version: 2,
      activeId: activeProfile?.id ?? null,
      activeProfile,
      profiles,
    };
  }
  catch {
    return emptyModelStore();
  }
}

/** Persist saved profiles and the independent activation snapshot together. */
export function writeModelStore(store: ModelStore, prefs: ModelStoreWriter = defaultWriter): void {
  if (store.version !== 2 || !Array.isArray(store.profiles)
    || !(store.activeId === null || validText(store.activeId, 256))) {
    throw new Error('MODEL_CONFIG_INVALID');
  }
  const profiles = store.profiles.map((profile) => readProfile(profile));
  if (profiles.some((profile) => profile === null)) throw new Error('MODEL_CONFIG_INVALID');
  const valid = profiles as ModelProfile[];
  const ids = new Set(valid.map((profile) => profile.id));
  const snapshot = store.activeProfile === null ? null : readProfile(store.activeProfile);
  const saved = valid.find((profile) => profile.id === store.activeId);
  if (ids.size !== valid.length || (store.activeId === null ? store.activeProfile !== null
    : !saved || !snapshot || snapshot.id !== store.activeId || snapshot.revision > saved.revision)) {
    throw new Error('MODEL_CONFIG_INVALID');
  }
  prefs.set(MODEL_STORE_PREF, JSON.stringify({ version: 2, activeId: store.activeId, activeProfile: snapshot, profiles: valid }));
}
