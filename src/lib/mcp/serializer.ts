/**
 * Redaction of credentials and tokens in error text for MCP answers and structured logs.
 */

/**
 * Redacts credentials, tokens, and URIs carrying userinfo from error messages
 * before returning them to MCP clients or writing them to structured logs.
 */
export function redactErrorMessage(message: string): string {
  if (!message) return "Unknown error";
  let out = message;

  // 1. Redact URIs with credentials (scheme://user:pass@host), handling @ in passwords safely without ReDoS
  out = out.replace(/\b([a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/)[^/\s]+@/g, "$1[REDACTED]@");

  // 2. Redact Bearer tokens
  out = out.replace(/\b(bearer)\s+[^\s,;]+/gi, "$1 [REDACTED]");

  // 3. Redact JSON-style or quoted key-values: "password": "..." or password="...", 'token': '...'
  out = out.replace(
    /(["']?(?:password|passwd|secret|client_secret|token|access_token|refresh_token|api_key|apikey|secret_key|auth_token|private_key)["']?\s*[:=]\s*)(["'])(?:\\.|[^\\])*?\2/gi,
    "$1$2[REDACTED]$2",
  );

  // 4. Redact standard unquoted key-values and query parameters
  out = out.replace(
    /\b(password|passwd|secret|client_secret|token|access_token|refresh_token|api_key|apikey|secret_key|auth_token|private_key)\s*([:=])(\s*)(?!(?:password|passwd|secret|client_secret|token|access_token|refresh_token|api_key|apikey|secret_key|auth_token|private_key)\s*[:=])[^\s,;&"]+/gi,
    "$1$2$3[REDACTED]",
  );

  return out;
}

/**
 * Creates a sanitized Error object preserving error type, message structure,
 * and stack trace frames while redacting sensitive information from message and stack.
 */
export function redactError(error: unknown): Error {
  if (error instanceof Error) {
    const safeError = new Error(redactErrorMessage(error.message));
    safeError.name = error.name;
    if (error.stack) {
      safeError.stack = redactErrorMessage(error.stack);
    }
    return safeError;
  }
  return new Error(redactErrorMessage(String(error ?? "Unknown error")));
}
