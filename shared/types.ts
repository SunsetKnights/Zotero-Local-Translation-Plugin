// Shared task types and native JSONL protocol frames.
import type { ModelParameters } from './model-config';

export const PROTOCOL_VERSION = 1;

/** The plugin always requests Simplified Chinese, including for legacy profiles. */
export const TARGET_LANGUAGE = 'zh-CN';

export type TaskState = 'preparing' | 'running' | 'succeeded' | 'cancelled' | 'failed';

export type ErrorCode =
  | 'NO_SELECTION'
  | 'INPUT_TOO_LONG'
  | 'UNSUPPORTED_PLATFORM'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_CONFIG_INVALID'
  | 'MODEL_CHANGED'
  | 'GPU_UNAVAILABLE'
  | 'GPU_OUT_OF_MEMORY'
  | 'GPU_LOAD_FAILED'
  | 'MODEL_HASH_MISMATCH'
  | 'MODEL_FORMAT_UNSUPPORTED'
  | 'MODEL_SPLIT_UNSUPPORTED'
  | 'MODEL_LOAD_FAILED'
  | 'TEMPLATE_UNSUPPORTED'
  | 'ASSET_INSTALL_FAILED'
  | 'ENGINE_START_FAILED'
  | 'ENGINE_BUSY'
  | 'ENGINE_TIMEOUT'
  | 'ENGINE_CRASHED'
  | 'PROTOCOL_ERROR'
  | 'EMPTY_OUTPUT'
  | 'OUTPUT_TRUNCATED'
  | 'CANCELLED'
  | 'UNSUPPORTED_LANGUAGE';

export interface SelectionSnapshot {
  /** Per-session reader identity, not only the attachment id. */
  readerKey: string;
  attachmentId: number | null;
  rawText: string;
}

export interface TranslationTask {
  requestId: string;
  readerKey: string;
  generation: number;
  rawText: string;
  normalizedText: string;
  state: TaskState;
  partialText: string;
  resultText: string;
  errorCode: ErrorCode | null;
  truncated: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface TimingInfo {
  prefill?: number;
  generation?: number;
  totalMs?: number;
  ttftMs?: number | null;
}

export interface ReadyInfo {
  /** Legacy helpers may send this; selected models are not hashed. */
  modelSha256?: string;
  engineCommit: string;
  engineVersion?: string;
  buildId: string;
  contextTokens: number;
  threads: number;
  /** Negative means "all layers", 0 means CPU only. */
  gpuLayers?: number;
  gpuFallback?: boolean;
  gpuOffloaded?: boolean;
  devices?: DeviceInfo[];
  templateVersion: string;
  maxInputTokens: number;
  maxOutputTokens: number;
}

interface FrameBase {
  v: number;
  sessionId: string;
  id: string;
}

export interface InitFrame extends FrameBase {
  type: 'init';
  modelPath: string;
  modelParameters?: ModelParameters;
  allowCpuFallback?: boolean;
  gpuLayers?: number;
  contextTokens: number;
  threads: number;
}

export interface TranslateFrame extends FrameBase {
  type: 'translate';
  text: string;
  targetLanguage: typeof TARGET_LANGUAGE;
}

export interface CancelFrame extends FrameBase {
  type: 'cancel';
  targetId: string;
}

export interface PingFrame extends FrameBase {
  type: 'ping';
}

export interface ShutdownFrame extends FrameBase {
  type: 'shutdown';
}

export type OutgoingFrame = InitFrame | TranslateFrame | CancelFrame | PingFrame | ShutdownFrame;

export interface ReadyFrame extends FrameBase, ReadyInfo {
  type: 'ready';
}

export interface StartedFrame extends FrameBase {
  type: 'started';
  inputTokens: number;
}

export interface DeltaFrame extends FrameBase {
  type: 'delta';
  seq: number;
  text: string;
}

export interface ResultFrame extends FrameBase {
  type: 'result';
  text: string;
  finishReason: 'eos' | 'length';
  outputTokens: number;
  inputTokens: number;
  truncated?: boolean;
  timingMs?: { prefill: number; generation: number };
}

export interface ErrorFrame extends FrameBase {
  type: 'error';
  code: string;
  retryable: boolean;
  detail?: string;
  inputTokens?: number;
  limit?: number;
  partialOutputTokens?: number;
}

export interface CancelledFrame extends FrameBase {
  type: 'cancelled';
  reason?: string;
}

export interface AckFrame extends FrameBase {
  type: 'ack';
  targetId: string;
  outcome: 'accepted' | 'already-finished' | 'not-found';
}

export interface PongFrame extends FrameBase {
  type: 'pong';
}

export interface DevicesFrame {
  v: number;
  type: 'devices';
  engineCommit: string;
  buildId: string;
  devices: Array<{ name: string; description: string; type: 'cpu' | 'gpu' | 'accelerator' }>;
}

export interface DeviceInfo {
  name: string;
  description: string;
  type: 'cpu' | 'gpu' | 'accelerator';
}

export type IncomingFrame =
  | ReadyFrame
  | StartedFrame
  | DeltaFrame
  | ResultFrame
  | ErrorFrame
  | CancelledFrame
  | AckFrame
  | PongFrame;
