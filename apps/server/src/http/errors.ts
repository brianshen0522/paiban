import { ERROR_STATUS, type ErrorCode, type ErrorDetails } from '@paiban/shared';

/** An error the API answers with on purpose: code, English message for logs, optional details. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails | undefined;
  constructor(code: ErrorCode, message: string = code, details?: ErrorDetails) {
    super(message);
    this.code = code;
    this.details = details;
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
  body() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const fail = (code: ErrorCode, message?: string, details?: ErrorDetails): never => {
  throw new ApiError(code, message, details);
};
