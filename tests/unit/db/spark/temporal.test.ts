import { describe, expect, test } from "bun:test";
import { SPARK_ERROR_SENTENCES, SparkError } from "@/lib/db/providers/sql/spark/errors";
import {
  calendarIntervalText,
  dateText,
  dayTimeText,
  type IntervalFields,
  timeText,
  timestampText,
  yearMonthText,
} from "@/lib/db/providers/sql/spark/temporal";

/** Expects `run` to be refused as unreadable, with the sentence naming `what`. */
function refusedAsUnreadable(run: () => unknown, what: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SparkError);
  expect((caught as SparkError).category).toBe("unreadable");
  expect((caught as SparkError).message).toBe(SPARK_ERROR_SENTENCES.unreadable(what));
}

const INT64_MIN = BigInt("-9223372036854775808");
const INT64_MAX = BigInt("9223372036854775807");
const pad2 = (value: number): string => String(value).padStart(2, "0");

/** A year, month and day as ISO 8601 writes them: four digits for 0000 to 9999, else signed and expanded. */
function isoDate(year: number, month: number, day: number): string {
  const sign = year < 0 ? "-" : year > 9999 ? "+" : "";
  return `${sign}${String(Math.abs(year)).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

/**
 * The date of a day count read from `Date`, an oracle independent of the code under test. The proleptic Gregorian
 * calendar repeats every 400 years (146,097 days), so the count is moved into 1970 to 2369 by whole cycles and the
 * year moved back by as many, which reaches every int32 day count, far past the range a `Date` holds.
 */
function oracleDate(days: number): string {
  const cycles = Math.floor(days / 146_097);
  const date = new Date((days - cycles * 146_097) * 86_400_000);
  return isoDate(date.getUTCFullYear() + 400 * cycles, date.getUTCMonth() + 1, date.getUTCDate());
}

/** The timestamp_ntz text of `ms` epoch milliseconds plus `extra` microseconds (0 to 999), read from `Date`. */
function oracleTimestamp(ms: number, extra: number): string {
  const date = new Date(ms);
  const day = isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  const clock = [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()].map(pad2).join(":");
  const fraction = date.getUTCMilliseconds() * 1_000 + extra;
  return fraction === 0 ? `${day} ${clock}` : `${day} ${clock}.${String(fraction).padStart(6, "0").replace(/0+$/, "")}`;
}

describe("dateText", () => {
  test("is exact from the day count, the proleptic calendar's first day included", () => {
    expect(dateText(0)).toBe("1970-01-01");
    expect(dateText(19782)).toBe("2024-02-29");
    expect(dateText(-1)).toBe("1969-12-31");
    expect(dateText(-719162)).toBe("0001-01-01");
    expect(dateText(2932896)).toBe("9999-12-31");
  });

  test("writes a year outside 0001 to 9999 in ISO 8601's expanded form", () => {
    expect(dateText(2932897)).toBe("+10000-01-01");
    expect(dateText(-719163)).toBe("0000-12-31");
    expect(dateText(-719528)).toBe("0000-01-01");
    expect(dateText(-719529)).toBe("-0001-12-31");
  });

  test("reads both ends of the Date32 range, a 32-bit day count", () => {
    expect(dateText(2_147_483_647)).toBe("+5881580-07-11");
    expect(dateText(-2_147_483_648)).toBe("-5877641-06-23");
  });

  test("agrees with the Date oracle on each day of 400 years around year 0 and across the int32 range", () => {
    const misses: string[] = [];
    const check = (days: number): void => {
      const text = dateText(days);
      if (text !== oracleDate(days)) misses.push(`${days}: ${text} is not ${oracleDate(days)}`);
    };
    for (let days = -719_528 - 73_048; days < -719_528 + 73_049; days += 1) check(days);
    for (let days = -2_147_483_648; days <= 2_147_483_647; days += 65_537) check(days);
    expect(misses).toStrictEqual([]);
  });
});

describe("timestampText and timeText", () => {
  test("a zoned timestamp is the UTC instant with +00:00, the fraction without trailing zeros and none when zero", () => {
    expect(timestampText(BigInt(0), true)).toBe("1970-01-01 00:00:00+00:00");
    expect(timestampText(BigInt(1_709_164_800_123_450), true)).toBe("2024-02-29 00:00:00.12345+00:00");
    expect(timestampText(BigInt(-1), true)).toBe("1969-12-31 23:59:59.999999+00:00");
    expect(timestampText(BigInt("-62135596800000000"), true)).toBe("0001-01-01 00:00:00+00:00");
  });

  test("timestamp_ntz has no offset", () => {
    expect(timestampText(BigInt(45_296_000_001), false)).toBe("1970-01-01 12:34:56.000001");
  });

  test("a value just before or on a day boundary lands on the right day, before the epoch too", () => {
    expect(timestampText(BigInt(86_399_999_999), false)).toBe("1970-01-01 23:59:59.999999");
    expect(timestampText(BigInt(86_400_000_000), false)).toBe("1970-01-02 00:00:00");
    expect(timestampText(BigInt(-86_400_000_000), false)).toBe("1969-12-31 00:00:00");
    expect(timestampText(BigInt(-86_400_000_001), false)).toBe("1969-12-30 23:59:59.999999");
  });

  test("reads both ends of int64 with no overflow", () => {
    expect(timestampText(INT64_MAX, true)).toBe("+294247-01-10 04:00:54.775807+00:00");
    expect(timestampText(INT64_MIN, true)).toBe("-290308-12-21 19:59:05.224192+00:00");
  });

  test("agrees with the Date oracle across the range a Date holds, with and without a part millisecond", () => {
    const misses: string[] = [];
    for (let ms = -8_640_000_000_000_000; ms <= 8_640_000_000_000_000; ms += 172_837_158_427) {
      for (const extra of [0, 1, 999]) {
        const text = timestampText(BigInt(ms) * BigInt(1_000) + BigInt(extra), false);
        if (text !== oracleTimestamp(ms, extra)) misses.push(`${ms} ms + ${extra} us: ${text}`);
      }
    }
    expect(misses).toStrictEqual([]);
  });

  test("a time of day from nanoseconds, trailing zeros removed", () => {
    expect(timeText(BigInt(45_296_123_456_000))).toBe("12:34:56.123456");
    expect(timeText(BigInt(0))).toBe("00:00:00");
    expect(timeText(BigInt(86_399_999_999_999))).toBe("23:59:59.999999999");
  });

  test("a time of day outside one day is refused as unreadable", () => {
    refusedAsUnreadable(() => timeText(BigInt(-1)), "a time of day outside 00:00:00 to 23:59:59.999999999");
    refusedAsUnreadable(
      () => timeText(BigInt(86_400_000_000_000)),
      "a time of day outside 00:00:00 to 23:59:59.999999999",
    );
  });
});

describe("yearMonthText", () => {
  test("Spark's ANSI literal for each field range, the sign leading the quoted value", () => {
    expect(yearMonthText(43, { start: "YEAR", end: "MONTH" })).toBe("INTERVAL '3-7' YEAR TO MONTH");
    expect(yearMonthText(-43, { start: "YEAR", end: "MONTH" })).toBe("INTERVAL '-3-7' YEAR TO MONTH");
    expect(yearMonthText(36, { start: "YEAR", end: "YEAR" })).toBe("INTERVAL '3' YEAR");
    expect(yearMonthText(-36, { start: "YEAR", end: "YEAR" })).toBe("INTERVAL '-3' YEAR");
    expect(yearMonthText(43, { start: "MONTH", end: "MONTH" })).toBe("INTERVAL '43' MONTH");
    expect(yearMonthText(-43, { start: "MONTH", end: "MONTH" })).toBe("INTERVAL '-43' MONTH");
    expect(yearMonthText(-2147483648, { start: "YEAR", end: "MONTH" })).toBe("INTERVAL '-178956970-8' YEAR TO MONTH");
  });

  test("the largest int32, zero, and a part year under YEAR, whose sign Spark keeps on the truncated years", () => {
    expect(yearMonthText(2_147_483_647, { start: "YEAR", end: "MONTH" })).toBe("INTERVAL '178956970-7' YEAR TO MONTH");
    expect(yearMonthText(0, { start: "YEAR", end: "MONTH" })).toBe("INTERVAL '0-0' YEAR TO MONTH");
    expect(yearMonthText(-5, { start: "YEAR", end: "YEAR" })).toBe("INTERVAL '-0' YEAR");
  });

  test("a field range that is not a year-month range is refused as unreadable", () => {
    refusedAsUnreadable(
      () => yearMonthText(1, { start: "DAY", end: "DAY" }),
      "a year-month interval of the fields DAY",
    );
    refusedAsUnreadable(
      () => yearMonthText(1, { start: "MONTH", end: "YEAR" }),
      "a year-month interval of the fields MONTH TO YEAR",
    );
    refusedAsUnreadable(
      () => yearMonthText(1, { start: "YEAR", end: "SECOND" }),
      "a year-month interval of the fields YEAR TO SECOND",
    );
  });
});

describe("dayTimeText", () => {
  test("Spark's ANSI literal for each field range", () => {
    const micros = BigInt(93_784_567_891); // 1 day 02:03:04.567891
    expect(dayTimeText(micros, { start: "DAY", end: "SECOND" })).toBe("INTERVAL '1 02:03:04.567891' DAY TO SECOND");
    expect(dayTimeText(-micros, { start: "DAY", end: "SECOND" })).toBe("INTERVAL '-1 02:03:04.567891' DAY TO SECOND");
    expect(dayTimeText(BigInt(93_600_000_000), { start: "HOUR", end: "HOUR" })).toBe("INTERVAL '26' HOUR");
    expect(dayTimeText(BigInt(18_000_000_000), { start: "HOUR", end: "HOUR" })).toBe("INTERVAL '05' HOUR");
    expect(dayTimeText(BigInt(93_780_000_000), { start: "DAY", end: "MINUTE" })).toBe(
      "INTERVAL '1 02:03' DAY TO MINUTE",
    );
    expect(dayTimeText(BigInt(184_567_891), { start: "MINUTE", end: "SECOND" })).toBe(
      "INTERVAL '03:04.567891' MINUTE TO SECOND",
    );
    expect(dayTimeText(BigInt(5_500_000), { start: "SECOND", end: "SECOND" })).toBe("INTERVAL '05.5' SECOND");
    expect(dayTimeText(BigInt(0), { start: "DAY", end: "SECOND" })).toBe("INTERVAL '0 00:00:00' DAY TO SECOND");
    expect(dayTimeText(BigInt(86_400_000_000), { start: "DAY", end: "DAY" })).toBe("INTERVAL '1' DAY");
  });

  test("the remaining field ranges, a sign on a value under one day, and seconds padded only below ten", () => {
    expect(dayTimeText(BigInt(93_784_567_891), { start: "DAY", end: "HOUR" })).toBe("INTERVAL '1 02' DAY TO HOUR");
    expect(dayTimeText(BigInt(93_780_000_000), { start: "HOUR", end: "MINUTE" })).toBe(
      "INTERVAL '26:03' HOUR TO MINUTE",
    );
    expect(dayTimeText(BigInt(7_384_567_891), { start: "HOUR", end: "SECOND" })).toBe(
      "INTERVAL '02:03:04.567891' HOUR TO SECOND",
    );
    expect(dayTimeText(BigInt(180_000_000), { start: "MINUTE", end: "MINUTE" })).toBe("INTERVAL '03' MINUTE");
    expect(dayTimeText(BigInt(-1), { start: "DAY", end: "SECOND" })).toBe(
      "INTERVAL '-0 00:00:00.000001' DAY TO SECOND",
    );
    expect(dayTimeText(BigInt(9_999_999), { start: "SECOND", end: "SECOND" })).toBe("INTERVAL '09.999999' SECOND");
    expect(dayTimeText(BigInt(9_000_000), { start: "MINUTE", end: "SECOND" })).toBe(
      "INTERVAL '00:09' MINUTE TO SECOND",
    );
    expect(dayTimeText(BigInt(10_000_000), { start: "SECOND", end: "SECOND" })).toBe("INTERVAL '10' SECOND");
    expect(dayTimeText(BigInt(100_000_001), { start: "SECOND", end: "SECOND" })).toBe("INTERVAL '100.000001' SECOND");
    expect(dayTimeText(BigInt(0), { start: "SECOND", end: "SECOND" })).toBe("INTERVAL '00' SECOND");
  });

  test("the smallest int64 reads as Spark prints it, with no overflow", () => {
    expect(dayTimeText(INT64_MIN, { start: "DAY", end: "SECOND" })).toBe(
      "INTERVAL '-106751991 04:00:54.775808' DAY TO SECOND",
    );
    expect(dayTimeText(INT64_MIN, { start: "HOUR", end: "SECOND" })).toBe(
      "INTERVAL '-2562047788:00:54.775808' HOUR TO SECOND",
    );
  });

  test("the smallest int64 matches Spark's own special case in every field range, and the largest reads too", () => {
    // Spark writes Long.MinValue through a special case, since negating it overflows a long (toDayTimeIntervalString
    // in SparkIntervalUtils, which IntervalUtils extends; the same in 4.1.0 and 4.2.0): the leading field is -MAX_DAY,
    // -MAX_HOUR, -MAX_MINUTE or -MAX_SECOND.775808, then the part of "-106751991 04:00:54.775808" the range needs.
    const expected: readonly (readonly [IntervalFields, string])[] = [
      [{ start: "DAY", end: "DAY" }, "INTERVAL '-106751991' DAY"],
      [{ start: "DAY", end: "HOUR" }, "INTERVAL '-106751991 04' DAY TO HOUR"],
      [{ start: "DAY", end: "MINUTE" }, "INTERVAL '-106751991 04:00' DAY TO MINUTE"],
      [{ start: "DAY", end: "SECOND" }, "INTERVAL '-106751991 04:00:54.775808' DAY TO SECOND"],
      [{ start: "HOUR", end: "HOUR" }, "INTERVAL '-2562047788' HOUR"],
      [{ start: "HOUR", end: "MINUTE" }, "INTERVAL '-2562047788:00' HOUR TO MINUTE"],
      [{ start: "HOUR", end: "SECOND" }, "INTERVAL '-2562047788:00:54.775808' HOUR TO SECOND"],
      [{ start: "MINUTE", end: "MINUTE" }, "INTERVAL '-153722867280' MINUTE"],
      [{ start: "MINUTE", end: "SECOND" }, "INTERVAL '-153722867280:54.775808' MINUTE TO SECOND"],
      [{ start: "SECOND", end: "SECOND" }, "INTERVAL '-9223372036854.775808' SECOND"],
    ];
    expect(expected.map(([fields]) => dayTimeText(INT64_MIN, fields))).toStrictEqual(expected.map(([, text]) => text));
    expect(dayTimeText(INT64_MAX, { start: "DAY", end: "SECOND" })).toBe(
      "INTERVAL '106751991 04:00:54.775807' DAY TO SECOND",
    );
  });

  test("a field range that is not a day-time range is refused as unreadable", () => {
    expect(() => dayTimeText(BigInt(1), { start: "YEAR", end: "MONTH" })).toThrow(SparkError);
    expect(() => dayTimeText(BigInt(1), { start: "SECOND", end: "DAY" })).toThrow(SparkError);
    refusedAsUnreadable(
      () => dayTimeText(BigInt(1), { start: "YEAR", end: "MONTH" }),
      "a day-time interval of the fields YEAR TO MONTH",
    );
    refusedAsUnreadable(
      () => dayTimeText(BigInt(1), { start: "SECOND", end: "DAY" }),
      "a day-time interval of the fields SECOND TO DAY",
    );
    refusedAsUnreadable(
      () => dayTimeText(BigInt(1), { start: "DAY", end: "MONTH" }),
      "a day-time interval of the fields DAY TO MONTH",
    );
    refusedAsUnreadable(
      () => dayTimeText(BigInt(1), { start: "MONTH", end: "MONTH" }),
      "a day-time interval of the fields MONTH",
    );
  });
});

describe("calendarIntervalText", () => {
  test("months, days and microseconds, the nanoseconds divided by 1000", () => {
    expect(calendarIntervalText(3, 2, BigInt(1_000))).toBe("3 months 2 days 1 microseconds");
    expect(calendarIntervalText(-1, 0, BigInt(-5_000_000))).toBe("-1 months 0 days -5000 microseconds");
  });

  test("a part microsecond is cut toward zero, and the largest int64 reads whole", () => {
    expect(calendarIntervalText(0, 0, BigInt(-1_999))).toBe("0 months 0 days -1 microseconds");
    expect(calendarIntervalText(0, 0, INT64_MAX)).toBe("0 months 0 days 9223372036854775 microseconds");
  });
});

describe("JSON safety", () => {
  test("every text is a string, so no bigint leaves the provider", () => {
    const texts = [
      dateText(0),
      timestampText(BigInt(1), true),
      timeText(BigInt(1)),
      yearMonthText(1, { start: "YEAR", end: "MONTH" }),
      dayTimeText(BigInt(1), { start: "DAY", end: "SECOND" }),
      calendarIntervalText(1, 1, BigInt(1000)),
    ];
    expect(() => JSON.stringify(texts)).not.toThrow();
    for (const text of texts) expect(typeof text).toBe("string");
  });
});
