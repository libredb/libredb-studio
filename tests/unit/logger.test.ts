import '../setup';
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Mock } from 'bun:test';
import { logger } from '@/lib/logger';

describe('logger', () => {
  let debugSpy: Mock<typeof console.debug>;
  let infoSpy: Mock<typeof console.info>;
  let warnSpy: Mock<typeof console.warn>;
  let errorSpy: Mock<typeof console.error>;
  let savedLogLevel: string | undefined;

  beforeEach(() => {
    savedLogLevel = process.env.LOG_LEVEL;
    delete process.env.LOG_LEVEL;
    debugSpy = spyOn(console, 'debug').mockImplementation(() => {});
    infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    if (savedLogLevel !== undefined) {
      process.env.LOG_LEVEL = savedLogLevel;
    } else {
      delete process.env.LOG_LEVEL;
    }
  });

  // ─── Basic logging calls ──────────────────────────────────────────────────

  test('logger.debug() calls console.debug with correct format', () => {
    logger.debug('hello debug');
    expect(debugSpy).toHaveBeenCalledTimes(1);
    const line = debugSpy.mock.calls[0][0] as string;
    expect(line).toContain('[DEBUG]');
    expect(line).toContain('hello debug');
    // Should contain an ISO timestamp
    expect(line).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
  });

  test('logger.info() calls console.info with correct format', () => {
    logger.info('hello info');
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = infoSpy.mock.calls[0][0] as string;
    expect(line).toContain('[INFO ]');
    expect(line).toContain('hello info');
  });

  test('logger.warn() calls console.warn with correct format', () => {
    logger.warn('hello warn');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0][0] as string;
    expect(line).toContain('[WARN ]');
    expect(line).toContain('hello warn');
  });

  test('logger.error() calls console.error with error info extracted', () => {
    const err = new TypeError('something broke');
    logger.error('failure', err);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).toContain('[ERROR]');
    expect(line).toContain('failure');
    expect(line).toContain('TypeError');
    expect(line).toContain('something broke');
  });

  // ─── Level filtering ──────────────────────────────────────────────────────

  test('when LOG_LEVEL=warn, debug and info should not log', () => {
    process.env.LOG_LEVEL = 'warn';
    logger.debug('should not appear');
    logger.info('should not appear either');
    logger.warn('should appear');
    logger.error('should also appear');

    expect(debugSpy).toHaveBeenCalledTimes(0);
    expect(infoSpy).toHaveBeenCalledTimes(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test('when LOG_LEVEL=error, only error should log', () => {
    process.env.LOG_LEVEL = 'error';
    logger.debug('nope');
    logger.info('nope');
    logger.warn('nope');
    logger.error('yes');

    expect(debugSpy).toHaveBeenCalledTimes(0);
    expect(infoSpy).toHaveBeenCalledTimes(0);
    expect(warnSpy).toHaveBeenCalledTimes(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test('when LOG_LEVEL=debug, all levels should log', () => {
    process.env.LOG_LEVEL = 'debug';
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  // ─── Context formatting ───────────────────────────────────────────────────

  test('context formatting: route appears in output', () => {
    logger.info('request', { route: '/api/db/query' });
    const line = infoSpy.mock.calls[0][0] as string;
    expect(line).toContain('route=/api/db/query');
  });

  test('context formatting: provider appears in output', () => {
    logger.info('connecting', { provider: 'postgres' });
    const line = infoSpy.mock.calls[0][0] as string;
    expect(line).toContain('provider=postgres');
  });

  test('context formatting: connectionId appears in output', () => {
    logger.info('connected', { connectionId: 'abc-123' });
    const line = infoSpy.mock.calls[0][0] as string;
    expect(line).toContain('connId=abc-123');
  });

  test('context formatting: duration appears in output', () => {
    logger.info('query done', { duration: 42 });
    const line = infoSpy.mock.calls[0][0] as string;
    expect(line).toContain('duration=42ms');
  });

  test('context formatting: all fields appear together', () => {
    logger.info('full context', {
      route: '/api/db/query',
      provider: 'mysql',
      connectionId: 'conn-1',
      duration: 100,
    });
    const line = infoSpy.mock.calls[0][0] as string;
    expect(line).toContain('route=/api/db/query');
    expect(line).toContain('provider=mysql');
    expect(line).toContain('connId=conn-1');
    expect(line).toContain('duration=100ms');
  });

  test('context formatting: extra keys are included', () => {
    logger.info('extra', { route: '/test', customKey: 'customVal' });
    const line = infoSpy.mock.calls[0][0] as string;
    expect(line).toContain('customKey=customVal');
  });

  // ─── Error extraction ─────────────────────────────────────────────────────

  test('error extraction: Error name and message appear in output', () => {
    const err = new RangeError('out of bounds');
    logger.error('bad range', err);
    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).toContain('RangeError');
    expect(line).toContain('out of bounds');
  });

  test('non-Error argument to logger.error() is stringified', () => {
    logger.error('weird error', 'just a string');
    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).toContain('Unknown');
    expect(line).toContain('just a string');
  });

  test('non-Error object argument to logger.error() is stringified', () => {
    logger.error('object error', { code: 42 });
    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).toContain('Unknown');
    expect(line).toContain('[object Object]');
  });

  test('logger.error() with no error argument does not include error info', () => {
    logger.error('simple error');
    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).toContain('[ERROR]');
    expect(line).toContain('simple error');
    // No error info pipe separator
    expect(line).not.toContain(' | ');
  });

  test('logger.error() with null error does not include error info', () => {
    logger.error('null error', null);
    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).not.toContain(' | ');
  });
});
