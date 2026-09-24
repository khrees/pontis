export class PontisError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: {
        type: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

// Authentication errors
export class AuthenticationError extends PontisError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'authentication_error', 401, details);
  }
}

export class InvalidApiKeyError extends AuthenticationError {
  constructor(reason: string = 'Invalid or missing API key') {
    super(reason, { reason });
  }
}

export class ApiKeyLengthError extends AuthenticationError {
  constructor(minLength: number, actualLength: number) {
    super(
      `API key is too short. Must be at least ${minLength} characters (got ${actualLength})`,
      { minLength, actualLength }
    );
  }
}

// Upstream errors
export class UpstreamError extends PontisError {
  constructor(
    message: string,
    public readonly upstreamStatus?: number,
    public readonly upstreamBody?: string,
    details?: Record<string, unknown>
  ) {
    super(message, 'upstream_error', 502, {
      ...(upstreamStatus ? { upstream_status: upstreamStatus } : {}),
      ...(upstreamBody ? { upstream_body: upstreamBody } : {}),
      ...details,
    });
  }
}

export class UpstreamTimeoutError extends UpstreamError {
  constructor(timeoutMs: number) {
    super('Upstream did not respond in time', undefined, undefined, { timeoutMs });
  }
}

export class UpstreamConnectionError extends UpstreamError {
  constructor(message: string = 'Failed to connect to upstream') {
    super(message);
  }
}

// Request validation errors
export class ValidationError extends PontisError {
  constructor(message: string, field?: string, value?: unknown) {
    super(message, 'validation_error', 400, {
      ...(field ? { field } : {}),
      ...(value !== undefined ? { value } : {}),
    });
  }
}

// Streaming errors
export class StreamError extends PontisError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'stream_error', 500, details);
  }
}

export class StreamBufferOverflowError extends StreamError {
  constructor(bufferSize: number, maxSize: number) {
    super(
      `Stream buffer exceeded maximum size (${bufferSize} > ${maxSize})`,
      { bufferSize, maxSize }
    );
  }
}

export class StreamParseError extends StreamError {
  constructor(chunk: string, parseError: Error) {
    super(`Failed to parse stream chunk: ${parseError.message}`, {
      chunk: chunk.substring(0, 100),
      originalError: parseError.message,
    });
  }
}

// Error type guard utilities
export function isPontisError(error: unknown): error is PontisError {
  return error instanceof PontisError;
}

// Error to HTTP response converter
export function errorToResponse(error: unknown, requestId?: string): Response {
  if (isPontisError(error)) {
    const headers = {
      'Content-Type': 'application/json',
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
    };
    return new Response(JSON.stringify(error.toJSON()), {
      status: error.statusCode,
      headers,
    });
  }

  if (error instanceof Error) {
    const pontisError = new PontisError(error.message, 'internal_error', 500);
    const headers = {
      'Content-Type': 'application/json',
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
    };
    return new Response(JSON.stringify(pontisError.toJSON()), {
      status: 500,
      headers,
    });
  }

  const pontisError = new PontisError(
    'An unknown error occurred',
    'unknown_error',
    500
  );
  return new Response(JSON.stringify(pontisError.toJSON()), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
}