/**
 * Values as the console's grids write them: `humanReadableSize` is a port of the AWS CLI's
 * `human_readable_size`, whose `%.1f` rounds half to even on the exact binary value where `toFixed` does not; `ls`
 * dates are the CLI's 19-character form in UTC; `s3api` dates are ISO 8601 UTC with milliseconds; an ETag gets back
 * the quotes the core removed.
 */
import { describe, expect, test } from "bun:test";
import { cliEtag, humanReadableSize, isoUtc, lsDate } from "@/lib/db/providers/objectstore/s3/console/format";

describe("humanReadableSize equals the AWS CLI on every recorded value", () => {
  test.each([
    [0, "0 Bytes"],
    [1, "1 Byte"],
    [2, "2 Bytes"],
    [1023, "1023 Bytes"],
    [1024, "1.0 KiB"],
    [1075, "1.0 KiB"],
    [1126, "1.1 KiB"],
    [1280, "1.2 KiB"],
    [1331, "1.3 KiB"],
    [1536, "1.5 KiB"],
    [1792, "1.8 KiB"],
    [1048575, "1.0 MiB"],
    [1048576, "1.0 MiB"],
    [2863288, "2.7 MiB"],
    [5368709120, "5.0 GiB"],
    [1098974756864, "1.0 TiB"],
    [1152921504606846976, "1.0 EiB"],
  ])("%d is %s", (bytes, written) => {
    expect(humanReadableSize(bytes)).toBe(written);
  });

  test("the half-to-even case is the one toFixed gets wrong", () => {
    expect((1.25).toFixed(1)).toBe("1.3");
    expect(humanReadableSize(1280)).toBe("1.2 KiB");
  });
});

describe("dates and ETags", () => {
  test("lsDate writes YYYY-MM-DD HH:MM:SS in UTC", () => {
    expect(lsDate("2026-01-02T03:04:05.000Z")).toBe("2026-01-02 03:04:05");
    expect(lsDate("2026-01-02T05:04:05+02:00")).toBe("2026-01-02 03:04:05");
  });

  test("isoUtc writes ISO 8601 UTC with milliseconds", () => {
    expect(isoUtc("2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05.000Z");
    expect(isoUtc("2026-01-02T05:04:05.250+02:00")).toBe("2026-01-02T03:04:05.250Z");
  });

  test("a timestamp the core kept verbatim because it did not parse is shown verbatim", () => {
    expect(lsDate("not a date")).toBe("not a date");
    expect(isoUtc("not a date")).toBe("not a date");
  });

  test("cliEtag restores the quotes, including on a multipart ETag", () => {
    expect(cliEtag("d41d8cd98f00b204e9800998ecf8427e")).toBe('"d41d8cd98f00b204e9800998ecf8427e"');
    expect(cliEtag("9b2cf535f27731c974343645a3985328-3")).toBe('"9b2cf535f27731c974343645a3985328-3"');
  });
});
