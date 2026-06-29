/**
 * Custom error types for consistent error handling across Pontis.
 * Each error type provides specific context and recovery information.
 */

// Base error class for all Pontis-specific errors
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

export class InvalidRequestError extends ValidationError {
  constructor(message: string) {
    super(message);
  }
}

export class MissingParameterError extends ValidationError {
  constructor(parameter: string) {
    super(`Missing required parameter: ${parameter}`, parameter);
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
      chunk: chunk.substring(0, 100), // First 100 chars for debugging
      originalError: parseError.message,
    });
  }
}

// Configuration errors
export class ConfigurationError extends PontisError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'configuration_error', 500, details);
  }
}

export class MissingConfigurationError extends ConfigurationError {
  constructor(configKey: string) {
    super(`Missing required configuration: ${configKey}`, { configKey });
  }
}

// Translation errors
export class TranslationError extends PontisError {
  constructor(message: string, fromFormat: string, toFormat: string, details?: Record<string, unknown>) {
    super(
      message,
      'translation_error',
      500,
      { fromFormat, toFormat, ...details }
    );
  }
}

export class UnsupportedFormatError extends TranslationError {
  constructor(format: string) {
    super(`Unsupported format: ${format}`, format, 'unknown', { format });
  }
}

// Provider-specific errors
export class ProviderError extends PontisError {
  constructor(
    message: string,
    public readonly provider: string,
    details?: Record<string, unknown>
  ) {
    super(message, 'provider_error', 502, { provider, ...details });
  }
}

export class ModelNotFoundError extends ProviderError {
  constructor(provider: string, model: string) {
    super(`Model not found: ${model}`, provider, { model });
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(provider: string, reason?: string) {
    super(
      `Provider unavailable: ${provider}${reason ? ` (${reason})` : ''}`,
      provider,
      { reason }
    );
  }
}

// Error type guard utilities
export function isPontisError(error: unknown): error is PontisError {
  return error instanceof PontisError;
}

export function isAuthenticationError(error: unknown): error is AuthenticationError {
  return error instanceof AuthenticationError;
}

export function isUpstreamError(error: unknown): error is UpstreamError {
  return error instanceof UpstreamError;
}

export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

export function isStreamError(error: unknown): error is StreamError {
  return error instanceof StreamError;
}

export function isConfigurationError(error: unknown): error is ConfigurationError {
  return error instanceof ConfigurationError;
}

export function isTranslationError(error: unknown): error is TranslationError {
  return error instanceof TranslationError;
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
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

  // Handle standard errors
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

  // Handle unknown errors
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

// Async error wrapper for consistent error handling
export async function withErrorHandling<T>(
  operation: () => Promise<T>,
  errorHandler?: (error: unknown) => T
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (errorHandler) {
      return errorHandler(error);
    }
    throw error; // Re-throw if no handler provided
  }
}

// Safe JSON parsing with error handling
export function safeJsonParse<T>(json: string, fallback?: T): T | null {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    if (fallback !== undefined) {
      return fallback;
    }
    return null;
  }
}

// Safe URL parsing with error handling
export function safeUrlParse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}