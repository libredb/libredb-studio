/**
 * The directory's entry point re-exports the two provider classes and nothing else (InfluxDB spec I2, I23).
 *
 * The factory imports `providers/timeseries/influxdb/index` for both type-ids, so this module is the one name the
 * rest of the app reaches the directory by; a helper exported here would become a second way in that no seam guard
 * reads.
 */
import { describe, expect, test } from "bun:test";
import * as entry from "@/lib/db/providers/timeseries/influxdb/index";
import { InfluxDBProvider } from "@/lib/db/providers/timeseries/influxdb/influxql-provider";
import { InfluxDB3Provider } from "@/lib/db/providers/timeseries/influxdb/sql-provider";

describe("timeseries/influxdb/index", () => {
  test("exports exactly the two provider classes", () => {
    expect(Object.keys(entry).sort()).toEqual(["InfluxDB3Provider", "InfluxDBProvider"]);
  });

  test("each export is the class its own module defines", () => {
    expect(entry.InfluxDBProvider).toBe(InfluxDBProvider);
    expect(entry.InfluxDB3Provider).toBe(InfluxDB3Provider);
  });
});
