/**
 * The two engine limiter keys (InfluxDB spec E16, R45).
 *
 * Each provider module creates its engine's limiter when it loads, so the bounds are a process-wide fact of the
 * module, not of a provider instance. The test reads `INFLUX_LIMITER_OPTIONS` rather than repeating its values: the
 * numbers are K3's measurement, and the bound under test is that both keys hold them.
 */
import { describe, expect, test } from "bun:test";
import "@/lib/db/providers/timeseries/influxdb/index";
import { INFLUX_LIMITER_OPTIONS } from "@/lib/db/providers/timeseries/influxdb/connection-options";
import { engineLimiter } from "@/lib/db/utils/bounded-limiter";

describe("InfluxDB engine limiter keys", () => {
  for (const key of ["influxdb", "influxdb3"] as const) {
    test(`loading the providers created "${key}", and a creation with other bounds throws`, () => {
      // Only a key that already exists can refuse other bounds, so this throw proves the module created it.
      expect(() =>
        engineLimiter(key, { ...INFLUX_LIMITER_OPTIONS, perEngine: INFLUX_LIMITER_OPTIONS.perEngine + 1 }),
      ).toThrow(`engineLimiter("${key}") was already created with other bounds`);
    });

    test(`"${key}" was created with INFLUX_LIMITER_OPTIONS`, () => {
      expect(() => engineLimiter(key, { ...INFLUX_LIMITER_OPTIONS })).not.toThrow();
    });
  }
});
