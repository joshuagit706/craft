/** Identifies which external service produced the error. */
export type ErrorDomain = 'github' | 'vercel' | 'stripe' | 'stellar' | 'auth' | 'general';

/**
 * Top-level error category grouping.
 * - validation: malformed or invalid client input
 * - auth: authentication or authorisation failures
 * - external: third-party service errors (GitHub, Vercel, Stripe, Stellar)
 * - internal: unexpected server-side errors
 */
export type ErrorCategory = 'validation' | 'auth' | 'external' | 'internal';

/**
 * Stable, never-to-be-changed error codes.
 * Format: <DOMAIN>_<DESCRIPTOR> — all upper-snake-case.
 * Once published, codes must not be renamed or removed.
 */
export type ErrorCode =
  // ── Validation ──────────────────────────────────────────────────────────
  | 'VALIDATION_INVALID_JSON'
  | 'VALIDATION_SCHEMA_ERROR'
  | 'VALIDATION_MISSING_FIELD'
  | 'VALIDATION_INVALID_FIELD'
  // ── Auth ────────────────────────────────────────────────────────────────
  | 'AUTH_UNAUTHENTICATED'
  | 'AUTH_FORBIDDEN'
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_EMAIL_TAKEN'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_TOKEN_INVALID'
  | 'AUTH_TOKEN_NOT_CONNECTED'
  // ── GitHub (external) ────────────────────────────────────────────────────
  | 'GITHUB_AUTH_FAILED'
  | 'GITHUB_RATE_LIMITED'
  | 'GITHUB_COLLISION'
  | 'GITHUB_NETWORK_ERROR'
  | 'GITHUB_CONFIGURATION_ERROR'
  | 'GITHUB_NOT_FOUND'
  // ── Vercel (external) ────────────────────────────────────────────────────
  | 'VERCEL_AUTH_FAILED'
  | 'VERCEL_RATE_LIMITED'
  | 'VERCEL_PROJECT_EXISTS'
  | 'VERCEL_NETWORK_ERROR'
  | 'VERCEL_NOT_FOUND'
  // ── Stripe (external) ────────────────────────────────────────────────────
  | 'STRIPE_CARD_DECLINED'
  | 'STRIPE_WEBHOOK_INVALID'
  | 'STRIPE_SUBSCRIPTION_NOT_FOUND'
  | 'STRIPE_NETWORK_ERROR'
  // ── Stellar (external) ───────────────────────────────────────────────────
  | 'STELLAR_INSUFFICIENT_BALANCE'
  | 'STELLAR_NETWORK_MISMATCH'
  | 'STELLAR_TRANSACTION_FAILED'
  | 'STELLAR_ENDPOINT_UNREACHABLE'
  | 'STELLAR_CONTRACT_INVALID'
  // ── Internal ────────────────────────────────────────────────────────────
  | 'INTERNAL_SERVER_ERROR'
  | 'INTERNAL_DATABASE_ERROR'
  | 'INTERNAL_CONFIGURATION_ERROR';

/** Maps each ErrorCode to its category and HTTP status. */
export interface ErrorCodeMeta {
  category: ErrorCategory;
  /** Default HTTP status code for this error. */
  httpStatus: number;
}

/** The standard error response shape returned by every API route. */
export interface ApiErrorResponse {
  /** Stable machine-readable code — safe to switch on in client code. */
  code: ErrorCode;
  /** Top-level grouping for the error. */
  category: ErrorCategory;
  /** Short, user-facing message. Never contains stack traces. */
  message: string;
  /** Optional field-level details (e.g., Zod validation errors). */
  details?: Record<string, unknown>;
  /** Correlation ID for tracing this error in server logs. */
  correlationId?: string;
}

/**
 * A reusable error message template.
 * Placeholders use `{key}` syntax and are replaced at call-site.
 */
export interface ErrorTemplate {
  /** Short, user-facing title. */
  title: string;
  /** Longer explanation. May contain `{placeholder}` tokens. */
  message: string;
  /** Whether the caller can meaningfully retry the operation. */
  retryable: boolean;
}

/** Step-by-step remediation guidance attached to an error code. */
export interface ErrorGuidance {
  template: ErrorTemplate;
  /** Ordered list of remediation steps shown to the user. */
  steps: string[];
  /** Links to relevant documentation or support resources. */
  links: Array<{ label: string; url: string }>;
}

/** Lookup table: ErrorCode → { category, httpStatus }. Stable — never mutate. */
export const ERROR_CODE_META: Record<ErrorCode, ErrorCodeMeta> = {
  // Validation — 400
  VALIDATION_INVALID_JSON:      { category: 'validation', httpStatus: 400 },
  VALIDATION_SCHEMA_ERROR:      { category: 'validation', httpStatus: 400 },
  VALIDATION_MISSING_FIELD:     { category: 'validation', httpStatus: 400 },
  VALIDATION_INVALID_FIELD:     { category: 'validation', httpStatus: 400 },
  // Auth — 401/403
  AUTH_UNAUTHENTICATED:         { category: 'auth', httpStatus: 401 },
  AUTH_FORBIDDEN:               { category: 'auth', httpStatus: 403 },
  AUTH_INVALID_CREDENTIALS:     { category: 'auth', httpStatus: 401 },
  AUTH_EMAIL_TAKEN:             { category: 'auth', httpStatus: 409 },
  AUTH_TOKEN_EXPIRED:           { category: 'auth', httpStatus: 401 },
  AUTH_TOKEN_INVALID:           { category: 'auth', httpStatus: 401 },
  AUTH_TOKEN_NOT_CONNECTED:     { category: 'auth', httpStatus: 401 },
  // GitHub — 502/429/409
  GITHUB_AUTH_FAILED:           { category: 'external', httpStatus: 502 },
  GITHUB_RATE_LIMITED:          { category: 'external', httpStatus: 429 },
  GITHUB_COLLISION:             { category: 'external', httpStatus: 409 },
  GITHUB_NETWORK_ERROR:         { category: 'external', httpStatus: 502 },
  GITHUB_CONFIGURATION_ERROR:   { category: 'external', httpStatus: 500 },
  GITHUB_NOT_FOUND:             { category: 'external', httpStatus: 404 },
  // Vercel
  VERCEL_AUTH_FAILED:           { category: 'external', httpStatus: 502 },
  VERCEL_RATE_LIMITED:          { category: 'external', httpStatus: 429 },
  VERCEL_PROJECT_EXISTS:        { category: 'external', httpStatus: 409 },
  VERCEL_NETWORK_ERROR:         { category: 'external', httpStatus: 502 },
  VERCEL_NOT_FOUND:             { category: 'external', httpStatus: 404 },
  // Stripe
  STRIPE_CARD_DECLINED:         { category: 'external', httpStatus: 402 },
  STRIPE_WEBHOOK_INVALID:       { category: 'external', httpStatus: 400 },
  STRIPE_SUBSCRIPTION_NOT_FOUND:{ category: 'external', httpStatus: 404 },
  STRIPE_NETWORK_ERROR:         { category: 'external', httpStatus: 502 },
  // Stellar
  STELLAR_INSUFFICIENT_BALANCE: { category: 'external', httpStatus: 402 },
  STELLAR_NETWORK_MISMATCH:     { category: 'external', httpStatus: 400 },
  STELLAR_TRANSACTION_FAILED:   { category: 'external', httpStatus: 422 },
  STELLAR_ENDPOINT_UNREACHABLE: { category: 'external', httpStatus: 502 },
  STELLAR_CONTRACT_INVALID:     { category: 'external', httpStatus: 400 },
  // Internal — 500
  INTERNAL_SERVER_ERROR:        { category: 'internal', httpStatus: 500 },
  INTERNAL_DATABASE_ERROR:      { category: 'internal', httpStatus: 500 },
  INTERNAL_CONFIGURATION_ERROR: { category: 'internal', httpStatus: 500 },
};
