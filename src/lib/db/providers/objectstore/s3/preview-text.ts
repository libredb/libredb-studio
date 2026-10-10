/**
 * Text helpers of the S3 preview. Browser-safe and pure. Oxia's printable rule and
 * hex dump layout are re-implemented here, never imported, because a provider imports nothing from another.
 */

// ignoreBOM keeps a leading U+FEFF, so the text is the bytes (as Oxia keeps it).
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The longest prefix of a ranged read that does not end inside a UTF-8 sequence (RFC 3629): the last byte among the
 * final four that is not a continuation byte, dropped with what follows it when its sequence is longer than the bytes
 * left; an ASCII byte, an invalid lead or no lead at all keeps every byte for the printable test to judge.
 */
export function utf8BackOff(bytes: Uint8Array): Uint8Array {
  const floor = Math.max(0, bytes.length - 4);
  for (let index = bytes.length - 1; index >= floor; index -= 1) {
    const byte = bytes[index];
    if ((byte & 0xc0) === 0x80) continue;
    const length =
      byte >= 0xc0 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf7 ? 4 : 0;
    return length > bytes.length - index ? bytes.subarray(0, index) : bytes;
  }
  return bytes;
}

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const DEL = 0x7f;

/** Valid UTF-8 in which no byte is 0x00 to 0x1F but tab, LF and CR, and no byte is 0x7F (Oxia's rule). */
export function isPrintableText(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === DEL) return false;
    if (byte < 0x20 && byte !== TAB && byte !== LF && byte !== CR) return false;
  }
  try {
    strictDecoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The text of bytes that passed `isPrintableText`. */
export function decodeText(bytes: Uint8Array): string {
  return strictDecoder.decode(bytes);
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const STRUCTURAL = new Set([",", ":", "{", "}", "[", "]", '"', " ", "\t", "\n", "\r"]);

/**
 * Valid JSON text in two-space layout, written by one string-aware pass that only removes and adds whitespace, so no
 * byte inside a string or a number changes and no integer is rounded. Depth is a counter, never recursion.
 * Returns undefined the moment the output would pass `limit`, before the piece that would pass it is written.
 */
export function reindentJson(text: string, limit: number): string | undefined {
  const pieces: string[] = [];
  let length = 0;
  let depth = 0;
  const push = (piece: string): boolean => {
    if (length + piece.length > limit) return false;
    pieces.push(piece);
    length += piece.length;
    return true;
  };
  const newline = (): boolean => {
    if (length + 1 + 2 * depth > limit) return false;
    return push(`\n${"  ".repeat(depth)}`);
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (WHITESPACE.has(char)) {
      index += 1;
    } else if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (!push(text.slice(index, end + 1))) return undefined;
      index = end + 1;
    } else if (char === "{" || char === "[") {
      const close = char === "{" ? "}" : "]";
      let next = index + 1;
      while (next < text.length && WHITESPACE.has(text[next])) next += 1;
      if (text[next] === close) {
        if (!push(`${char}${close}`)) return undefined;
        index = next + 1;
      } else {
        depth += 1;
        if (!push(char) || !newline()) return undefined;
        index += 1;
      }
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (!newline() || !push(char)) return undefined;
      index += 1;
    } else if (char === ",") {
      if (!push(",") || !newline()) return undefined;
      index += 1;
    } else if (char === ":") {
      if (!push(": ")) return undefined;
      index += 1;
    } else {
      let end = index;
      while (end < text.length && !STRUCTURAL.has(text[end])) end += 1;
      if (!push(text.slice(index, end))) return undefined;
      index = end;
    }
  }
  return pieces.join("");
}

/** The dump's last line when the object is longer than the bytes dumped. */
const HEX_DUMP_SHOWN = "The first {n} of {size} bytes are shown.";

const count = (value: number): string => value.toLocaleString("en-US");
const hex2 = (byte: number): string => byte.toString(16).padStart(2, "0");
/** The character a dump's right column shows for a byte: itself from 0x20 to 0x7E, a dot for any other. */
const dumpChar = (byte: number): string => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".");
/** The width of a dump line's hex column: 16 bytes of three characters and the space after the eighth. */
const HEX_COLUMN = 16 * 3 + 1;

/**
 * `bytes` as Go's `encoding/hex.Dumper` writes them: per line the offset in 8 lowercase hex digits, two spaces, 16
 * bytes as `xx ` with one more space after the eighth, the last line padded, ` |`, the 16 characters, `|` and LF; when
 * the object is longer than `bytes`, a last line says how many of how many are shown.
 */
export function hexDump(bytes: Uint8Array, objectBytes: number): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.subarray(offset, offset + 16);
    let hex = "";
    let chars = "";
    row.forEach((byte, index) => {
      hex += `${hex2(byte)} ${index === 7 ? " " : ""}`;
      chars += dumpChar(byte);
    });
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(HEX_COLUMN, " ")} |${chars}|\n`);
  }
  if (objectBytes > bytes.length) {
    lines.push(`${HEX_DUMP_SHOWN.replace("{n}", count(bytes.length)).replace("{size}", count(objectBytes))}\n`);
  }
  return lines.join("");
}

/** Console rows of 16 bytes: offset, the pairs separated by spaces, the dump's character column. */
export function hexRows(
  bytes: Uint8Array,
  maxRows: number,
): { readonly rows: readonly (readonly [string, string, string])[]; readonly more: boolean } {
  const rows: [string, string, string][] = [];
  for (let offset = 0; offset < bytes.length && rows.length < maxRows; offset += 16) {
    const row = Array.from(bytes.subarray(offset, offset + 16));
    rows.push([offset.toString(16).padStart(8, "0"), row.map(hex2).join(" "), row.map(dumpChar).join("")]);
  }
  return { rows, more: bytes.length > maxRows * 16 };
}

/** The text's lines (LF, with a CR before it removed), at most `maxRows`; a final LF ends the last line. */
export function textLines(
  text: string,
  maxRows: number,
): { readonly lines: readonly string[]; readonly more: boolean } {
  const all = text.split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const lines = all.slice(0, maxRows).map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  return { lines, more: all.length > maxRows };
}
