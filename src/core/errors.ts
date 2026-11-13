import type { ErrorCode } from '../../shared/types';

export interface ErrorDefinition {
  code: ErrorCode;
  /** Fluent key in content/locale, not user-facing text. */
  messageKey: string;
  retryable: boolean;
  /** Shown as a dialog instead of an inline status. */
  report: boolean;
}

export const ERROR_DEFINITIONS: Record<ErrorCode, ErrorDefinition> = {
  NO_SELECTION: { code: 'NO_SELECTION', messageKey: 'translation-error-no-selection', retryable: false, report: false },
  INPUT_TOO_LONG: { code: 'INPUT_TOO_LONG', messageKey: 'translation-error-input-too-long', retryable: false, report: false },
  UNSUPPORTED_PLATFORM: { code: 'UNSUPPORTED_PLATFORM', messageKey: 'translation-error-unsupported-platform', retryable: false, report: true },
  MODEL_NOT_FOUND: { code: 'MODEL_NOT_FOUND', messageKey: 'translation-error-model-not-found', retryable: true, report: true },
  MODEL_NOT_CONFIGURED: { code: 'MODEL_NOT_CONFIGURED', messageKey: 'translation-error-model-not-configured', retryable: false, report: false },
  MODEL_CONFIG_INVALID: { code: 'MODEL_CONFIG_INVALID', messageKey: 'translation-error-model-config', retryable: false, report: false },
  MODEL_CHANGED: { code: 'MODEL_CHANGED', messageKey: 'translation-error-model-changed', retryable: false, report: false },
  GPU_UNAVAILABLE: { code: 'GPU_UNAVAILABLE', messageKey: 'translation-error-gpu-unavailable', retryable: false, report: false },
  GPU_OUT_OF_MEMORY: { code: 'GPU_OUT_OF_MEMORY', messageKey: 'translation-error-gpu-memory', retryable: false, report: false },
  GPU_LOAD_FAILED: { code: 'GPU_LOAD_FAILED', messageKey: 'translation-error-gpu-load', retryable: false, report: false },
  MODEL_HASH_MISMATCH: { code: 'MODEL_HASH_MISMATCH', messageKey: 'translation-error-model-hash', retryable: false, report: true },
  MODEL_FORMAT_UNSUPPORTED: { code: 'MODEL_FORMAT_UNSUPPORTED', messageKey: 'translation-error-model-format', retryable: false, report: true },
  MODEL_SPLIT_UNSUPPORTED: { code: 'MODEL_SPLIT_UNSUPPORTED', messageKey: 'translation-error-model-split', retryable: false, report: false },
  MODEL_LOAD_FAILED: { code: 'MODEL_LOAD_FAILED', messageKey: 'translation-error-model-load', retryable: true, report: false },
  TEMPLATE_UNSUPPORTED: { code: 'TEMPLATE_UNSUPPORTED', messageKey: 'translation-error-template', retryable: false, report: true },
  ASSET_INSTALL_FAILED: { code: 'ASSET_INSTALL_FAILED', messageKey: 'translation-error-asset-install', retryable: true, report: true },
  ENGINE_START_FAILED: { code: 'ENGINE_START_FAILED', messageKey: 'translation-error-engine-start', retryable: true, report: true },
  ENGINE_BUSY: { code: 'ENGINE_BUSY', messageKey: 'translation-error-busy', retryable: true, report: false },
  ENGINE_TIMEOUT: { code: 'ENGINE_TIMEOUT', messageKey: 'translation-error-timeout', retryable: true, report: false },
  ENGINE_CRASHED: { code: 'ENGINE_CRASHED', messageKey: 'translation-error-crashed', retryable: true, report: false },
  PROTOCOL_ERROR: { code: 'PROTOCOL_ERROR', messageKey: 'translation-error-protocol', retryable: true, report: false },
  EMPTY_OUTPUT: { code: 'EMPTY_OUTPUT', messageKey: 'translation-error-empty', retryable: true, report: false },
  OUTPUT_TRUNCATED: { code: 'OUTPUT_TRUNCATED', messageKey: 'translation-error-truncated', retryable: true, report: false },
  CANCELLED: { code: 'CANCELLED', messageKey: 'translation-status-cancelled', retryable: true, report: false },
  UNSUPPORTED_LANGUAGE: { code: 'UNSUPPORTED_LANGUAGE', messageKey: 'translation-error-language', retryable: false, report: true },
};

export function isKnownErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_DEFINITIONS, value);
}
