/**
 * 64-bit integers in JSON text.
 *
 * `JSON.parse` has no exact form for an integer wider than 2^53: it rounds one
 * silently, with no error at all. A server that sends a 64-bit column as an
 * UNQUOTED JSON number therefore cannot be parsed by the runtime alone, and the
 * only place left to fix it is the raw text, before it is parsed.
 *
 * A caller runs `quoteUnsafeIntegers` over an answer body before parsing it, and
 * again over any JSON text a string value of that body carries (a query plan
 * column, for example): the outer pass rightly leaves digits inside a string
 * alone, so the inner parse is a second, independent chance to round the same
 * value.
 *
 * Nothing here belongs to an engine: it is a property of JSON text and of
 * `JSON.parse`.
 */

/** `Number.MAX_SAFE_INTEGER` as digits: the widest integer JSON.parse keeps exact. */
const SAFE_DIGITS = String(Number.MAX_SAFE_INTEGER);

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

/**
 * True when a digit run cannot survive `JSON.parse`.
 *
 * Compared as DIGITS rather than as numbers, because converting it to a number to
 * find out whether converting it to a number is safe is the bug. Equal-length
 * digit strings compare numerically, and the safe range is symmetric
 * (`MIN_SAFE_INTEGER` is `-MAX_SAFE_INTEGER`), so the sign never matters.
 */
function exceedsSafeRange(digits: string): boolean {
  if (digits.length !== SAFE_DIGITS.length) return digits.length > SAFE_DIGITS.length;
  return digits > SAFE_DIGITS;
}

/** Index just past the string literal that starts at `start`, or the end of the text. */
function endOfString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    // An escape consumes the next character whatever it is. This is what keeps
    // `\"` from being read as the end of the string - the desync that would put
    // the scanner OUTSIDE a string it is still inside, and rewrite the digits
    // that follow into invalid JSON.
    if (char === "\\") {
      index += 2;
      continue;
    }
    index += 1;
    if (char === '"') break;
  }
  // An unterminated string means a truncated body (a cancelled query really does
  // cut its server's body mid-value): the rest is treated as string content, so
  // nothing is rewritten and JSON.parse is left to report the real problem.
  return index;
}

interface NumberSpan {
  end: number;
  /** The digits before any fraction or exponent, without the sign. */
  digits: string;
  /** False as soon as a fraction or an exponent appears: a double either way. */
  integral: boolean;
}

/** The JSON number starting at `start`, or null when nothing there starts one. */
function numberAt(text: string, start: number): NumberSpan | null {
  let index = text[start] === "-" ? start + 1 : start;

  const digitsStart = index;
  while (isDigit(text[index])) index += 1;
  if (index === digitsStart) return null;
  const digits = text.slice(digitsStart, index);

  let integral = true;
  if (text[index] === ".") {
    integral = false;
    index += 1;
    while (isDigit(text[index])) index += 1;
  }
  if (text[index] === "e" || text[index] === "E") {
    integral = false;
    index += 1;
    if (text[index] === "+" || text[index] === "-") index += 1;
    while (isDigit(text[index])) index += 1;
  }

  return { end: index, digits, integral };
}

/**
 * Quote every integer literal `JSON.parse` would round, leaving everything else
 * byte-for-byte alone.
 *
 * Live-verified on real ingested data: a BIGINT column holding 9007199254740993
 * (2^53 + 1) comes back from a SQL server's HTTP answer as the UNQUOTED JSON
 * number 9007199254740993, and `JSON.parse` turns it into 9007199254740992 with
 * no error whatsoever. The quoted value then reaches the caller as an exact
 * string.
 *
 * A single pass, and STRING-AWARE, which is the whole difficulty: a digit run
 * inside `"id: 9007199254740993"` is a value the user is reading and must not be
 * touched. Only integers are rewritten - a float is a double on both sides, so
 * quoting one would turn a number the grid can sort into a string it cannot.
 */
export function quoteUnsafeIntegers(jsonText: string): string {
  /** Non-null only once something needs rewriting, so the common body is returned as is. */
  let rewritten: string[] | null = null;
  let copiedTo = 0;
  let index = 0;

  while (index < jsonText.length) {
    if (jsonText[index] === '"') {
      index = endOfString(jsonText, index);
      continue;
    }

    const number = numberAt(jsonText, index);
    if (number === null) {
      index += 1;
      continue;
    }

    if (number.integral && exceedsSafeRange(number.digits)) {
      rewritten ??= [];
      rewritten.push(jsonText.slice(copiedTo, index), '"', jsonText.slice(index, number.end), '"');
      copiedTo = number.end;
    }
    index = number.end;
  }

  if (rewritten === null) return jsonText;

  rewritten.push(jsonText.slice(copiedTo));
  return rewritten.join("");
}

/**
 * True when some number literal in the text would come back different from a
 * `JSON.stringify(JSON.parse(text))` round trip.
 *
 * `quoteUnsafeIntegers` answers this for integers only, which is enough where the
 * value goes on to a grid cell. A caller that shows the JSON TEXT itself needs the
 * wider question, because a fraction or an exponent is rounded just as silently:
 * measured on a stored JSON document, a stored `12345678901234567890.12` came back as
 * 12345678901234567000, `0.1234567890123456789` as 0.12345678901234568 and `1e400`
 * as null. Each literal is compared with its own round trip, so a spelling the trip
 * would merely change (`1.0`) counts too: the stored text is the only one that is
 * certainly what was written. Digits inside a string value are skipped, the same
 * string-aware walk as above.
 */
export function carriesLossyNumber(jsonText: string): boolean {
  let index = 0;
  while (index < jsonText.length) {
    if (jsonText[index] === '"') {
      index = endOfString(jsonText, index);
      continue;
    }

    const number = numberAt(jsonText, index);
    if (number === null) {
      index += 1;
      continue;
    }

    const literal = jsonText.slice(index, number.end);
    if (JSON.stringify(Number(literal)) !== literal) return true;
    index = number.end;
  }
  return false;
}
