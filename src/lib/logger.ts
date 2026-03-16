/**
 * Structured Logger
 * Isomorphic logger with level filtering and context support
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  route?: string;
  provider?: string;
  connectionId?: string;
  duration?: number;
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getMinLevel(): LogLevel {
  if (typeof process !== 'undefined' && process.env?.LOG_LEVEL) {
    const env = process.env.LOG_LEVEL.toLowerCase();
    if (env in LEVEL_ORDER) return env as LogLevel;
  }
  const isDev =
    typeof process !== 'undefined' &&
    process.env?.NODE_ENV !== 'production';
  return isDev ? 'debug' : 'info';
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[getMinLevel()];
}

function formatContext(ctx?: LogContext): string {
  if (!ctx) return '';
  const parts: string[] = [];
  if (ctx.route) parts.push(`route=${ctx.route}`);
  if (ctx.provider) parts.push(`provider=${ctx.provider}`);
  if (ctx.connectionId) parts.push(`connId=${ctx.connectionId}`);
  if (ctx.duration !== undefined) parts.push(`duration=${ctx.duration}ms`);
  // Extra keys
  for (const [k, v] of Object.entries(ctx)) {
    if (['route', 'provider', 'connectionId', 'duration'].includes(k)) continue;
    if (v !== undefined) parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  return parts.length ? ` {${parts.join(', ')}}` : '';
}

function extractError(error: unknown): { name: string; message: string; stack?: string } | undefined {
  if (!error) return undefined;
  if (error instanceof Error) {
    const isDev =
      typeof process !== 'undefined' &&
      process.env?.NODE_ENV !== 'production';
    return {
      name: error.name,
      message: error.message,
      stack: isDev ? error.stack : undefined,
    };
  }
  return { name: 'Unknown', message: String(error) };
}

/** Sanitize log message to prevent log injection (newlines, control chars) */
function sanitizeLogValue(value: string): string {
  return value.replace(/[\r\n]/g, ' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function log(level: LogLevel, message: string, error?: unknown, context?: LogContext): void {
  if (!shouldLog(level)) return;

  const timestamp = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  const ctx = formatContext(context);
  const errInfo = level === 'error' ? extractError(error) : undefined;

  const line = `[${tag}] [${timestamp}]${sanitizeLogValue(ctx)} ${sanitizeLogValue(message)}`;

  if (errInfo) {
    const errLine = ` | ${sanitizeLogValue(errInfo.name)}: ${sanitizeLogValue(errInfo.message)}`;
    const full = line + errLine;
    if (errInfo.stack) {
      // Stack traces contain intentional newlines — sanitize control chars only
      const safeStack = errInfo.stack.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
      console.error(full, '\n', safeStack);
    } else {
      console.error(full);
    }
    return;
  }

  // All values in `line` are already sanitized via sanitizeLogValue
  const safeLine = line;
  switch (level) {
    case 'debug':
      console.debug(safeLine);
      break;
    case 'info':
      console.info(safeLine);
      break;
    case 'warn':
      console.warn(safeLine);
      break;
    case 'error':
      console.error(safeLine);
      break;
  }
}

export const logger = {
  debug(message: string, context?: LogContext): void {
    log('debug', message, undefined, context);
  },
  info(message: string, context?: LogContext): void {
    log('info', message, undefined, context);
  },
  warn(message: string, context?: LogContext): void {
    log('warn', message, undefined, context);
  },
  error(message: string, error?: unknown, context?: LogContext): void {
    log('error', message, error, context);
  },
};
