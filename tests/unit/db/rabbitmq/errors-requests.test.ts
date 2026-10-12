/**
 * Every read request a warning or an error quotes is one the user can paste back: each sentence is filled with names
 * that look like syntax, every quoted `{"vhost": ...}` request is cut out of it and passed through the request parser,
 * and the parse yields the original vhost and stream, never a cut or unescaped one, with the offset the sentence
 * promises. No control or bidi character reaches the sentence raw.
 */
import { describe, expect, test } from "bun:test";
import {
  conversionAfter,
  conversionNoRowKeyword,
  conversionNoRowNumeric,
  lastIdleWarning,
} from "@/lib/db/providers/stream/rabbitmq/errors";
import { parseReadRequest, type ReadRequest } from "@/lib/db/providers/stream/rabbitmq/request";

const cp = (code: number) => String.fromCodePoint(code);
/** A 255-byte name of two-byte characters, the longest a name may be, and names holding what the escaping must cover. */
const NAMES: readonly string[] = [
  "/",
  "%2F",
  "a b, c",
  'say "hi" \\ back',
  `line${cp(0x0a)}break${cp(0x09)}tab`,
  `${cp(0x202e)}evil${cp(0x2066)}`,
  `sep${cp(0x2028)}${cp(0x2029)}${cp(0x85)}`,
  `${cp(0xe9).repeat(127)}x`,
];
/** C0 controls, DEL, C1 controls, the two line separators and the bidi controls, by code point, so the source holds none raw. */
function hasRawControl(text: string): boolean {
  return [...text].some((char) => {
    const code = char.codePointAt(0) as number;
    return (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });
}

/** Every `{"vhost": ...}` object in a sentence, found by a scanner that skips JSON strings. */
function quotedRequests(sentence: string): string[] {
  const found: string[] = [];
  let from = sentence.indexOf('{"vhost"');
  while (from >= 0) {
    let depth = 0;
    let index = from;
    for (; index < sentence.length; index++) {
      const char = sentence[index];
      if (char === '"') {
        index++;
        while (sentence[index] !== '"') index += sentence[index] === "\\" ? 2 : 1;
      } else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) break;
    }
    found.push(sentence.slice(from, index + 1));
    from = sentence.indexOf('{"vhost"', index);
  }
  return found;
}

function roundTrip(sentence: string, vhost: string, stream: string): ReadRequest[] {
  expect(hasRawControl(sentence)).toBe(false);
  const requests = quotedRequests(sentence);
  expect(requests.length).toBeGreaterThan(0);
  return requests.map((text) => {
    const parsed = parseReadRequest(text);
    expect(parsed.vhost).toBe(vhost);
    expect(parsed.stream).toBe(stream);
    return parsed;
  });
}

describe("each quoted request parses back to the same vhost and stream", () => {
  test("the 255-byte name is the longest a request accepts", () => {
    expect(new TextEncoder().encode(NAMES[7]).length).toBe(255);
  });

  for (const vhost of NAMES) {
    const stream = NAMES[(NAMES.indexOf(vhost) + 3) % NAMES.length];

    test(`last idle: ${JSON.stringify(vhost)} / ${JSON.stringify(stream)}`, () => {
      const [request] = roundTrip(lastIdleWarning(vhost, stream, 3, BigInt(120)), vhost, stream);
      expect(request.from).toEqual({ kind: "offset", value: BigInt(70) });
      const [clamped] = roundTrip(lastIdleWarning(vhost, stream, 3, BigInt(20)), vhost, stream);
      expect(clamped.from).toEqual({ kind: "offset", value: BigInt(0) });
    });

    test(`541 after rows: ${JSON.stringify(vhost)}`, () => {
      for (const prefetch of [1, 10]) {
        const [request] = roundTrip(
          conversionAfter(BigInt("9223372036854775806"), prefetch, vhost, stream),
          vhost,
          stream,
        );
        expect(request.from).toEqual({ kind: "offset", value: BigInt("9223372036854775807") });
        expect(request.limit).toBe(1);
      }
    });

    test(`541 with no row, numeric start: ${JSON.stringify(vhost)}`, () => {
      for (const prefetch of [1, 10]) {
        const [request] = roundTrip(
          conversionNoRowNumeric(BigInt("9007199254740993"), prefetch, vhost, stream),
          vhost,
          stream,
        );
        expect(request.from).toEqual({ kind: "offset", value: BigInt("9007199254740993") });
        expect(request.limit).toBe(1);
      }
    });

    test(`541 with no row, keyword start: ${JSON.stringify(vhost)}`, () => {
      for (const [start, isLast] of [
        ['"last"', true],
        ['"next"', false],
        ['{"timestamp": "2026-10-11T08:30:15.000Z"}', false],
      ] as const) {
        const requests = roundTrip(conversionNoRowKeyword(start, isLast, vhost, stream), vhost, stream);
        expect(requests[0].from).toEqual({ kind: "keyword", value: "first" });
        expect(requests[0].limit).toBe(1);
      }
    });
  }
});
