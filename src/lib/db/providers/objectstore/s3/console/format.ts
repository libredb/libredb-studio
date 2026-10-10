/**
 * Values as the S3 console's grids write them.
 *
 * Pure, and shipped to the browser. `humanReadableSize` ports the AWS CLI's `human_readable_size`
 * (`awscli/customizations/s3/utils.py`): Python's `round` and `%.1f` round half to even on the exact binary value,
 * and JavaScript's `Math.round` and `toFixed` round a tie up, so the two ties are written out here.
 */

const BASE = 1_024;
const SUFFIXES = ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB"] as const;

/** Python's `round(x)`: to the nearest whole number, a tie to the even one. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Python's `'%.1f' % x`. A tie at one decimal is exactly representable only as `.25` or `.75`; `toFixed` takes the
 * larger tenth, which is right for `.75` (8 is even) and wrong for `.25`, where the even tenth is 2.
 */
function oneDecimal(value: number): string {
  const whole = Math.floor(value);
  return value - whole === 0.25 ? `${whole}.2` : value.toFixed(1);
}

/** The AWS CLI's spelling of a size: `1 Byte`, `<n> Bytes` below 1,024, else one decimal in the first unit that fits. */
export function humanReadableSize(bytes: number): string {
  if (bytes === 1) return "1 Byte";
  if (bytes < BASE) return `${Math.trunc(bytes)} Bytes`;
  let index = 0;
  while (index < SUFFIXES.length - 1 && roundHalfEven((bytes / BASE ** (index + 2)) * BASE) >= BASE) index += 1;
  return `${oneDecimal((BASE * bytes) / BASE ** (index + 2))} ${SUFFIXES[index]}`;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** The `ls` grid's date: the AWS CLI's 19-character form, in UTC; a text that does not parse is kept as it is. */
export function lsDate(timestamp: string): string {
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return timestamp;
  const date = new Date(time);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** An `s3api` grid's date: ISO 8601 UTC with milliseconds; a text that does not parse is kept as it is. */
export function isoUtc(timestamp: string): string {
  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? timestamp : new Date(time).toISOString();
}

/** The ETag as the server and the AWS CLI show it: the core removed its quotes, and this puts them back. */
export function cliEtag(etag: string): string {
  return `"${etag}"`;
}
