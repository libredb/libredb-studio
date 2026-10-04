/**
 * An Oxia value as the grid and the Source tab show it (SB2-6.2 to SB2-6.5), a key as a sentence names it, and a
 * version timestamp as a cell (SB2-6.1).
 *
 * Pure. Oxia stores bytes and says nothing of their encoding, so the classifier decides from the bytes alone, first
 * match wins: `--hex` asked, not UTF-8, not printable text, JSON, text. Printable text excludes the C0 controls but
 * tab, LF and CR, and DEL, so a Pulsar ledger flag (`08 01`), which is valid UTF-8, is shown as hex. Rule 4 is
 * etcd's `isJson`, so `123` is JSON on both providers.
 */
import { quoteShellWord } from "@/lib/db/console/shell-words";
import { OXIA_SHOWN_KEY_CHARS } from "./constants";

export type OxiaValueEncoding = "json" | "text" | "hex" | "withheld";

export interface OxiaValueView {
  /** What a cell shows: the text, or the hex pairs, cut at the cell bound. */
  readonly text: string;
  readonly encoding: OxiaValueEncoding;
  readonly byteLength: number;
  /** True when `text` was cut at the cell bound; the grid then writes the encoding with ", cut" (SB2-6.3). */
  readonly cut: boolean;
}

/** The `value` cell of a value over the receive cap, whose `value_encoding` is `withheld` (SB2-6.2). */
export const WITHHELD_VALUE_TEXT = "value larger than 16 MiB, withheld";

// ignoreBOM keeps a leading U+FEFF: without it the decoder drops it and the text is not the bytes.
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeStrict(bytes: Uint8Array): string | undefined {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const DEL = 0x7f;

/** Whether no byte is a C0 control other than tab, LF and CR, and none is DEL. */
function holdsNoControl(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === DEL) return false;
    if (byte < 0x20 && byte !== TAB && byte !== LF && byte !== CR) return false;
  }
  return true;
}

/** Printable text: valid UTF-8 in which no byte is 0x00 to 0x1F but tab, LF and CR, and no byte is 0x7F (SB2-6.2). */
export function isPrintableText(bytes: Uint8Array): boolean {
  return holdsNoControl(bytes) && decodeStrict(bytes) !== undefined;
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

const hex2 = (byte: number): string => byte.toString(16).padStart(2, "0");

function hexPairs(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += hex2(byte);
  return out;
}

/** Text cut at `limit` UTF-16 units, never between the two units of one character. */
function cutText(text: string, limit: number): string {
  const last = text.charCodeAt(limit - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

/**
 * The value as a grid cell shows it (SB2-6.2, SB2-6.3, SB2-6.4): the encoding by the first rule that matches, the text
 * cut at `cellLimit` characters, and a hex cell as two lowercase digits per byte, so it shows the first
 * `cellLimit / 2` bytes. `cellLimit` is a whole number from 1, or Infinity for no bound.
 */
export function viewOxiaValue(
  bytes: Uint8Array,
  options: { readonly hex: boolean; readonly cellLimit: number },
): OxiaValueView {
  const { cellLimit } = options;
  if (cellLimit !== Number.POSITIVE_INFINITY && !(Number.isInteger(cellLimit) && cellLimit >= 1)) {
    throw new RangeError("The cell bound is a whole number of characters, 1 or more, or Infinity for none");
  }
  const byteLength = bytes.length;
  const text = options.hex || !holdsNoControl(bytes) ? undefined : decodeStrict(bytes);
  if (text === undefined) {
    const whole = byteLength * 2;
    if (whole <= cellLimit) return { text: hexPairs(bytes), encoding: "hex", byteLength, cut: false };
    return { text: hexPairs(bytes.subarray(0, Math.floor(cellLimit / 2))), encoding: "hex", byteLength, cut: true };
  }
  const encoding: OxiaValueEncoding = parsesAsJson(text) ? "json" : "text";
  if (text.length <= cellLimit) return { text, encoding, byteLength, cut: false };
  return { text: cutText(text, cellLimit), encoding, byteLength, cut: true };
}

/** The character a dump's right column shows for a byte: itself from 0x20 to 0x7E, a dot for any other. */
const dumpChar = (byte: number): string => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".");

/** The width of a dump line's hex column: 16 bytes of three characters and the space after the eighth. */
const HEX_COLUMN = 16 * 3 + 1;

const count = (n: number): string => n.toLocaleString("en-US");

/**
 * The bytes as Go's `encoding/hex.Dumper` writes them, which the oxia CLI prints for `--hex` (SB2-6.4): per line the
 * offset in 8 lowercase hex digits, two spaces, 16 bytes as `xx ` with one more space after the eighth, the last line
 * padded to the full width, then ` |`, the 16 characters, `|` and LF. At most `maxBytes` bytes are dumped; past them
 * a last line says how many of how many are shown.
 */
export function hexDump(bytes: Uint8Array, maxBytes: number): string {
  const shown = bytes.subarray(0, maxBytes);
  const lines: string[] = [];
  for (let offset = 0; offset < shown.length; offset += 16) {
    const row = shown.subarray(offset, offset + 16);
    let hex = "";
    let chars = "";
    row.forEach((byte, index) => {
      hex += `${hex2(byte)} ${index === 7 ? " " : ""}`;
      chars += dumpChar(byte);
    });
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(HEX_COLUMN, " ")} |${chars}|\n`);
  }
  if (bytes.length > maxBytes) lines.push(`The first ${count(maxBytes)} of ${count(bytes.length)} bytes are shown.\n`);
  return lines.join("");
}

/** Whether `text` holds an unpaired UTF-16 surrogate. */
function holdsLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/**
 * A key as a notice names it (SB2-6.5): quoteShellWord's form, or JSON's when the key holds a character no command
 * line spells (a CR, a U+0000, a lone surrogate), cut at 120 characters with "...".
 */
export function shownKey(key: string): string {
  const spelled =
    key.includes("\r") || key.includes("\u0000") || holdsLoneSurrogate(key) ? JSON.stringify(key) : quoteShellWord(key);
  const characters = Array.from(spelled);
  return characters.length > OXIA_SHOWN_KEY_CHARS
    ? `${characters.slice(0, OXIA_SHOWN_KEY_CHARS).join("")}...`
    : spelled;
}

/** The largest epoch milliseconds a JavaScript Date holds. */
const LAST_DATE_MS = BigInt(8_640_000_000_000_000);
const FIXED64 = /^(?:0|[1-9][0-9]*)$/;

/**
 * A fixed64 epoch-milliseconds timestamp as a cell shows it (SB2-6.1): ISO 8601 UTC with milliseconds, the CLI's
 * form; past JavaScript's date range, the decimal string and " ms". The wire carries the number as a decimal string;
 * anything else is a defect of the caller and throws.
 */
export function isoFromEpochMs(ms: string): string {
  if (!FIXED64.test(ms)) throw new RangeError("An Oxia timestamp is a decimal string of epoch milliseconds");
  if (BigInt(ms) > LAST_DATE_MS) return `${ms} ms`;
  return new Date(Number(ms)).toISOString();
}
