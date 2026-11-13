/** Settings shared by the configuration UI and the native init protocol. */
export interface ModelParameters {
  promptTemplate: string;
  /** Empty means use the chat template embedded in the GGUF. */
  chatTemplate: string;
  contextTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  seed: number;
}

export interface ModelMetadata {
  name: string;
  architecture: string;
  /** Zero means the metadata does not advertise a context limit. */
  contextLength: number;
  chatTemplate: string;
  splitCount: number;
  fileType: number;
}

export interface ModelProfile {
  id: string;
  name: string;
  /** Zero denotes a new draft; saved revisions start at one. */
  revision: number;
  device: ModelDeviceSettings;
  path: string;
  presetId: string | null;
  presetVersion: number | null;
  /** Saved values are authoritative; preset updates never replace them. */
  parameters: ModelParameters;
  fileSize: number;
  lastModified: number;
  metadata?: ModelMetadata;
}

export interface ModelStore {
  version: 2;
  activeId: string | null;
  /** Independent last-activated snapshot; saved edits never replace it. */
  activeProfile: ModelProfile | null;
  profiles: ModelProfile[];
}

export interface ModelDeviceSettings {
  useGpu: boolean;
  threads: number;
  /** -1 requests all layers; a positive integer requests partial offload. */
  gpuLayers: number;
}

export interface ModelPreset {
  id: string;
  version: number;
  label: string;
  description: string;
  parameters: Readonly<ModelParameters>;
}

export interface ParameterIssue {
  field: keyof ModelParameters | 'model';
  message: string;
}

export interface ProfileIssue {
  field: ParameterIssue['field'] | 'name' | 'path' | 'id' | 'revision' | 'fileSize' | 'lastModified'
    | 'device' | `device.${keyof ModelDeviceSettings}`;
  message: string;
}
