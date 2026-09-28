/**
 * Safe serializer for the MCP protocol.
 * Prevents runtime crashes caused by native database types (BigInt, Buffers, Dates, circular refs).
 */

function serializeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Handle BigInt (PostgreSQL int8, SQLite 64-bit int)
  if (typeof value === "bigint") {
    return value.toString();
  }

  // Handle non-finite numbers
  if (typeof value === "number") {
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      return null;
    }
    return value;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  // Handle Dates (including crash prevention for Invalid Date)
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  // Handle Buffers and binary data (BLOBs)
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[Blob: ${value.length} bytes]`;
  }

  // Handle Errors
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  // Handle Objects and Arrays with cycle prevention and hostile getters
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);

    try {
      if (Array.isArray(value)) {
        return value.map((item) => serializeValue(item, seen));
      }

      // fromEntries defines own data properties, so a column named __proto__ stays a key
      // instead of reaching the prototype setter an assignment would call.
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializeValue(v, seen)]));
    } catch {
      return String(value);
    } finally {
      seen.delete(value);
    }
  }

  return String(value);
}

/**
 * Converts any data structure returned by SQL drivers into a JSON-safe object.
 */
export function safeSerialize<T>(data: T): T {
  return serializeValue(data, new Set<object>()) as T;
}

/**
 * Serializes query data to JSON safely without throwing TypeError on BigInt or cyclic references.
 */
export function safeJsonStringify(data: unknown, space?: number): string {
  const safeData = safeSerialize(data);
  return JSON.stringify(safeData, null, space);
}

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
