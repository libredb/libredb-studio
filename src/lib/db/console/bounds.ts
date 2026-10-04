/**
 * The console text's size in UTF-8 bytes, the unit every console bound is stated in (vector-family spec 3.4).
 *
 * Counted from the UTF-16 code units without encoding the text: a code unit below 0x80 is one byte, below 0x800
 * two, a surrogate pair four, and any other unit three, a lone surrogate included, because an encoder writes it
 * as U+FFFD, which is three bytes.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Whether the text is longer than `limit` UTF-8 bytes. Every code unit is one to three bytes, so a text of more
 * than `limit` units is over and one of at most a third of `limit` units is under, both without counting; only
 * the texts in between are counted.
 */
export function exceedsUtf8Bytes(text: string, limit: number): boolean {
  if (text.length > limit) return true;
  if (text.length * 3 <= limit) return false;
  return utf8ByteLength(text) > limit;
}
