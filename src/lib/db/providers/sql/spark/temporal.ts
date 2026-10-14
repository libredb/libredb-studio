/**
 * Exact date, timestamp, time and interval texts from the raw integers Spark sends: no Date object and no
 * fraction held in a double, so 0001-01-01 and the int64 extremes come out exact and an interval reads as Spark prints
 * it. A day or month count is an int32, whose every quotient below is exact in a double; anything finer than a day is
 * BigInt. A time of day or a field range outside its type is refused as unreadable, never written as a text Spark does
 * not print. Pure: no I/O, no logger.
 */
import { SPARK_ERROR_SENTENCES, SparkError } from "./errors";

export type IntervalUnit = "YEAR" | "MONTH" | "DAY" | "HOUR" | "MINUTE" | "SECOND";

export interface IntervalFields {
  readonly start: IntervalUnit;
  readonly end: IntervalUnit;
}

// BigInt(...) rather than literals: the repository's TypeScript target, ES2017, has no BigInt literal.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const SIXTY = BigInt(60);
const SECONDS_PER_HOUR = BigInt(3_600);
const NANOS_PER_MICRO = BigInt(1_000);
const MICROS_PER_SECOND = BigInt(1_000_000);
const NANOS_PER_SECOND = BigInt(1_000_000_000);
const MICROS_PER_DAY = BigInt(86_400_000_000);
const NANOS_PER_DAY = BigInt(86_400_000_000_000);
const YEAR_MONTH: readonly IntervalUnit[] = ["YEAR", "MONTH"];
const DAY_TIME: readonly IntervalUnit[] = ["DAY", "HOUR", "MINUTE", "SECOND"];
const MICROS_PER: Readonly<Record<string, bigint>> = {
  DAY: MICROS_PER_DAY,
  HOUR: BigInt(3_600_000_000),
  MINUTE: BigInt(60_000_000),
};

const pad2 = (value: number | bigint): string => String(value).padStart(2, "0");

/** A year as ISO 8601 writes it: four digits for 0000 to 9999 (0000 is 1 BCE), else signed and expanded. */
function yearText(year: number): string {
  if (year >= 0 && year <= 9999) return String(year).padStart(4, "0");
  return year > 9999 ? `+${year}` : `-${String(-year).padStart(4, "0")}`;
}

/** The proleptic Gregorian date of a day count from 1970-01-01 (the civil-from-days algorithm). */
export function dateText(days: number): string {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return `${yearText(year)}-${pad2(month)}-${pad2(day)}`;
}

/** `HH:MM:SS[.f]` of nanoseconds into a day, the fraction without trailing zeros and none when zero. */
function clockText(nanos: bigint): string {
  const seconds = nanos / NANOS_PER_SECOND;
  const fraction = nanos % NANOS_PER_SECOND;
  const text = `${pad2(seconds / SECONDS_PER_HOUR)}:${pad2((seconds / SIXTY) % SIXTY)}:${pad2(seconds % SIXTY)}`;
  return fraction === ZERO ? text : `${text}.${String(fraction).padStart(9, "0").replace(/0+$/, "")}`;
}

/** A timestamp's microseconds since the epoch as `YYYY-MM-DD HH:MM:SS[.f]`, with `+00:00` when zoned. */
export function timestampText(micros: bigint, zoned: boolean): string {
  let days = micros / MICROS_PER_DAY;
  let rest = micros % MICROS_PER_DAY;
  if (rest < ZERO) {
    rest += MICROS_PER_DAY;
    days -= ONE;
  }
  const text = `${dateText(Number(days))} ${clockText(rest * NANOS_PER_MICRO)}`;
  return zoned ? `${text}+00:00` : text;
}

/** A TIME value's nanoseconds into the day; a count outside one day is refused as unreadable. */
export function timeText(nanos: bigint): string {
  if (nanos < ZERO || nanos >= NANOS_PER_DAY) {
    throw new SparkError(
      "unreadable",
      SPARK_ERROR_SENTENCES.unreadable("a time of day outside 00:00:00 to 23:59:59.999999999"),
    );
  }
  return clockText(nanos);
}

const range = (fields: IntervalFields): string =>
  fields.start === fields.end ? fields.start : `${fields.start} TO ${fields.end}`;

/** Where a field range starts and ends in `units`; refused as unreadable unless both ends are there, in order. */
function fieldPositions(
  units: readonly IntervalUnit[],
  fields: IntervalFields,
  what: string,
): readonly [number, number] {
  const start = units.indexOf(fields.start);
  const end = units.indexOf(fields.end);
  if (start === -1 || end < start) {
    throw new SparkError("unreadable", SPARK_ERROR_SENTENCES.unreadable(`${what} of the fields ${range(fields)}`));
  }
  return [start, end];
}

/** Spark's ANSI literal of a year-month interval of `months`. */
export function yearMonthText(months: number, fields: IntervalFields): string {
  fieldPositions(YEAR_MONTH, fields, "a year-month interval");
  const sign = months < 0 ? "-" : "";
  const abs = Math.abs(months);
  const years = Math.trunc(abs / 12);
  const value =
    fields.start !== fields.end
      ? `${sign}${years}-${abs % 12}`
      : fields.start === "YEAR"
        ? `${sign}${years}`
        : `${months}`;
  return `INTERVAL '${value}' ${range(fields)}`;
}

/** Seconds of a microsecond count, two digits at least, the fraction without trailing zeros. */
function secondsText(micros: bigint): string {
  const whole = micros / MICROS_PER_SECOND;
  const fraction = micros % MICROS_PER_SECOND;
  const digits = pad2(whole);
  return fraction === ZERO ? digits : `${digits}.${String(fraction).padStart(6, "0").replace(/0+$/, "")}`;
}

/** Spark's ANSI literal of a day-time interval of `micros`. BigInt arithmetic, so the int64 minimum needs no case. */
export function dayTimeText(micros: bigint, fields: IntervalFields): string {
  const [start, end] = fieldPositions(DAY_TIME, fields, "a day-time interval");
  let rest = micros < ZERO ? -micros : micros;
  let text = micros < ZERO ? "-" : "";
  for (let index = start; index <= end; index += 1) {
    const unit = DAY_TIME[index];
    const separator = index === start ? "" : unit === "HOUR" ? " " : ":";
    if (unit === "SECOND") {
      text += `${separator}${secondsText(rest)}`;
      break;
    }
    const value = rest / MICROS_PER[unit];
    rest %= MICROS_PER[unit];
    text += `${separator}${unit === "DAY" ? String(value) : pad2(value)}`;
  }
  return `INTERVAL '${text}' ${range(fields)}`;
}

/** A calendar interval as `<m> months <d> days <us> microseconds`, Spark's microseconds being nanoseconds / 1000. */
export function calendarIntervalText(months: number, days: number, nanos: bigint): string {
  return `${months} months ${days} days ${nanos / NANOS_PER_MICRO} microseconds`;
}
