import { describe, test, expect } from 'bun:test';
import {
  encodeText,
  decodeText,
  createSSEParser,
  createErrorStream,
} from '@/lib/llm/utils/streaming';

// ============================================================================
// Helper: read all chunks from a ReadableStream
// ============================================================================

async function readAllChunks(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decodeText(value);
  }
  return result;
}

async function pipeSSE(input: string): Promise<string> {
  const parser = createSSEParser();
  const inputStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeText(input));
      controller.close();
    },
  });
  const outputStream = inputStream.pipeThrough(parser);
  return readAllChunks(outputStream);
}

// ============================================================================
// encodeText / decodeText
// ============================================================================

describe('encodeText', () => {
  test('converts string to Uint8Array', () => {
    const result = encodeText('hello');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('decodeText', () => {
  test('converts Uint8Array back to string', () => {
    const bytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    expect(decodeText(bytes)).toBe('hello');
  });
});

describe('encodeText + decodeText roundtrip', () => {
  test('roundtrip preserves the string', () => {
    const original = 'Hello, World! 123 @#$';
    const encoded = encodeText(original);
    const decoded = decodeText(encoded);
    expect(decoded).toBe(original);
  });

  test('roundtrip handles unicode characters', () => {
    const original = 'Merhaba dunya';
    const encoded = encodeText(original);
    const decoded = decodeText(encoded);
    expect(decoded).toBe(original);
  });
});

// ============================================================================
// createSSEParser
// ============================================================================

describe('createSSEParser', () => {
  test('parses OpenAI-format SSE data line and extracts content', async () => {
    const input = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
    const output = await pipeSSE(input);
    expect(output).toBe('hello');
  });

  test('handles [DONE] marker without producing output', async () => {
    const input = 'data: {"choices":[{"delta":{"content":"hi"}}]}\ndata: [DONE]\n\n';
    const output = await pipeSSE(input);
    expect(output).toBe('hi');
  });

  test('skips malformed JSON lines', async () => {
    const input = 'data: not-valid-json\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n';
    const output = await pipeSSE(input);
    expect(output).toBe('ok');
  });

  test('handles multiple data chunks and concatenates content', async () => {
    const input = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" World"}}]}',
      'data: [DONE]',
      '',
    ].join('\n');

    const output = await pipeSSE(input);
    expect(output).toBe('Hello World');
  });

  test('skips comment lines starting with ":"', async () => {
    const input = [
      ': this is a comment',
      'data: {"choices":[{"delta":{"content":"content"}}]}',
      '',
    ].join('\n');

    const output = await pipeSSE(input);
    expect(output).toBe('content');
  });

  test('skips empty lines', async () => {
    const input = [
      '',
      'data: {"choices":[{"delta":{"content":"value"}}]}',
      '',
      '',
    ].join('\n');

    const output = await pipeSSE(input);
    expect(output).toBe('value');
  });

  test('skips data lines where delta has no content field', async () => {
    const input = [
      'data: {"choices":[{"delta":{}}]}',
      'data: {"choices":[{"delta":{"content":"real"}}]}',
      '',
    ].join('\n');

    const output = await pipeSSE(input);
    expect(output).toBe('real');
  });
});

// ============================================================================
// createErrorStream
// ============================================================================

describe('createErrorStream', () => {
  test('emits "Error: <message>" and closes', async () => {
    const stream = createErrorStream('something went wrong');
    const output = await readAllChunks(stream);
    expect(output).toBe('Error: something went wrong');
  });

  test('stream is finite (closes after emitting)', async () => {
    const stream = createErrorStream('test');
    const reader = stream.getReader();

    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decodeText(first.value!)).toBe('Error: test');

    const second = await reader.read();
    expect(second.done).toBe(true);
  });
});
