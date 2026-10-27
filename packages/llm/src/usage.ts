import type { Role } from './config.js';

export interface Usage {
  role: Role;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costUsd: number | null;
}

export type LlmErrorCode = 'invalid_output' | 'timeout' | 'http' | 'no_tool_call';

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly status?: number;
  constructor(code: LlmErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
