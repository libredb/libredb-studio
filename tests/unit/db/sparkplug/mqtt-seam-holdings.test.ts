/**
 * The holdings record holds what the current guard holds, so adopting it cannot quietly narrow
 * the sweep. The numbers come from the real directory, read at test time.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  allGuardedWriteSites,
  allSweptDirectories,
  heldByAnotherMqttGuard,
  MQTT_SEAM_HOLDINGS,
} from "../../../helpers/mqtt-seam-holdings";

const REPO = path.join(import.meta.dir, "..", "..", "..", "..");

describe("the record describes today's repository, not a wish", () => {
  test("every swept directory exists and holds .ts files", () => {
    for (const dir of allSweptDirectories()) {
      const files = readdirSync(path.join(REPO, dir)).filter((n) => n.endsWith(".ts"));
      expect(files.length).toBeGreaterThan(0);
    }
  });

  test("a row whose provider directory does not exist yet sweeps nothing", () => {
    // The other half of the same invariant: once the directory appears, this test fails until the
    // row names it, so a landed provider cannot stay unswept.
    for (const [name, holding] of Object.entries(MQTT_SEAM_HOLDINGS)) {
      if (holding.providerDirectory === undefined) continue;
      const exists = existsSync(path.join(REPO, holding.providerDirectory));
      expect(holding.sweptDirectories.includes(holding.providerDirectory), `${name} row`).toBe(exists);
    }
  });

  test("the FILES that write are exactly the declared ones, and the COUNT matches too", () => {
    /*
     * Two claims, kept apart because they fail for different reasons. A file that writes and is
     * not declared is a new seam nobody reviewed; a declared file with more writes than declared
     * is a new packet nobody reviewed. The first is about place and the second about number.
     */
    const perFile = new Map<string, number>();
    for (const dir of allSweptDirectories()) {
      for (const name of readdirSync(path.join(REPO, dir)).filter((n) => n.endsWith(".ts"))) {
        const code = readFileSync(path.join(REPO, dir, name), "utf8")
          .replaceAll(/\/\*[\s\S]*?\*\//g, "")
          .replaceAll(/\/\/.*$/gm, "");
        const hits = (code.match(/\.write\(/g) ?? []).length;
        if (hits > 0) perFile.set(`${dir}/${name}`, hits);
      }
    }
    expect([...perFile.keys()].sort()).toEqual([...allGuardedWriteSites()].sort());
    const total = [...perFile.values()].reduce((n, hits) => n + hits, 0);
    const declared = Object.values(MQTT_SEAM_HOLDINGS).reduce((n, holding) => n + holding.allowedWriteSites, 0);
    expect(total).toBe(declared);
  });

  test("EVERY write in the Sparkplug session is handed a packet its own encoder produced", () => {
    /*
     * The claim that replaced "this directory cannot write". A write passed bytes from anywhere
     * else would be a packet nothing in this repository checked, and the encoder is the module
     * with no function that writes a publish, so routing every write through it is what keeps the
     * read-only guarantee true now that writes exist.
     */
    const code = readFileSync(path.join(REPO, "src/lib/db/providers/industrial/sparkplug/session.ts"), "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/\/\/.*$/gm, "");
    // No dotAll flag, and none is needed: `[^;]` already crosses newlines, and the class stops at
    // the statement's own semicolon, so a write cannot swallow the next statement. The repository
    // targets ES2017, where the flag does not exist anyway.
    const writes = [...code.matchAll(/\.write\(([^;]*?)\)\s*;/g)].map((match) => match[1].trim());
    expect(writes).toHaveLength(5);
    for (const argument of writes) {
      expect(argument).toMatch(/^encode(Connect|Subscribe|Unsubscribe|PingReq|Disconnect)\(/);
    }
    // All five encoders are used, so none of them is dead and none is called twice in place of
    // another.
    expect(writes.map((a) => a.slice(0, a.indexOf("("))).sort()).toEqual([
      "encodeConnect",
      "encodeDisconnect",
      "encodePingReq",
      "encodeSubscribe",
      "encodeUnsubscribe",
    ]);
  });

  test("a row's count and its file list cannot contradict each other", () => {
    /*
     * THIS ASSERTION USED TO EQUATE THE TWO, AND THAT WAS ONLY TRUE BY ACCIDENT. It read
     * `allGuardedWriteSites().length === sum(allowedWriteSites)`, which holds exactly while every
     * writing file has exactly one write in it. The shipped `mqtt` session happens to, so nothing
     * failed; `session.ts` here has five writes in one file and the old equation broke. The equation
     * was never the invariant, it was a coincidence of the only row that existed.
     *
     * The invariant is weaker in one direction and sharper in the other: a file list cannot be
     * longer than the count it describes, and zero has to mean zero on both sides. How many writes
     * each listed file really holds is a question about the repository rather than about this
     * record, and the first test in this file is the one that answers it by reading the code.
     */
    for (const [name, holding] of Object.entries(MQTT_SEAM_HOLDINGS)) {
      expect(holding.guardedWriteSites.length, name).toBeLessThanOrEqual(holding.allowedWriteSites);
      expect(holding.allowedWriteSites === 0, name).toBe(holding.guardedWriteSites.length === 0);
      // A path listed twice would let a second file's writes hide behind the first one's budget.
      expect(new Set(holding.guardedWriteSites).size, name).toBe(holding.guardedWriteSites.length);
    }
    // And the index still reports every row's files, which is what the sweep reads.
    expect(allGuardedWriteSites().length).toBe(
      Object.values(MQTT_SEAM_HOLDINGS).reduce((n, h) => n + h.guardedWriteSites.length, 0),
    );
  });
});

describe("the rows carve the repository up without overlapping", () => {
  test("each path is held by EXACTLY the row it belongs to, no more and no less", () => {
    // ONE-SIDED BEFORE, AND A MUTATION PROVED IT. The first version only asserted
    // `rows.length <= 1`, which catches a path held twice but says nothing about a path held by
    // NOBODY. Deleting a pattern from the sparkplug row passed every test. The expected row is
    // named per path now, so both directions fail loudly.
    const expected: ReadonlyArray<readonly [string, string | null]> = [
      ["src/lib/db/mqtt/session.ts", "transport"],
      ["tests/unit/db/mqtt/transport/outbound.test.ts", "transport"],
      ["tests/helpers/mqtt-seam-holdings.ts", "transport"],
      // `mqtt`'s own files are held by NOBODY on purpose: its guard is the default one.
      ["src/lib/db/providers/keyvalue/mqtt/session.ts", null],
      ["src/lib/db/providers/industrial/sparkplug/decode.ts", "sparkplug"],
      ["tests/unit/db/sparkplug/values.test.ts", "sparkplug"],
      ["tests/live/sparkplug-live-check.ts", "sparkplug"],
      ["tests/helpers/sparkplug-captures.ts", "sparkplug"],
    ];
    for (const [path, row] of expected) {
      const hit = Object.entries(MQTT_SEAM_HOLDINGS).filter(([, h]) => h.held.some((r) => r.test(path)));
      expect(
        hit.map(([name]) => name),
        path,
      ).toEqual(row === null ? [] : [row]);
    }
  });

  test("the mqtt row holds nothing, so the default guard covers it", () => {
    expect(MQTT_SEAM_HOLDINGS.mqtt.held).toHaveLength(0);
    expect(heldByAnotherMqttGuard("src/lib/db/providers/keyvalue/mqtt/session.ts")).toBe(false);
  });

  test("the sparkplug row permits writes in ONE file, and names which", () => {
    /*
     * The claim this row makes changed when the provider got its own session, and it is recorded
     * here rather than relaxed. Before: nothing in the directory writes. Now: one file writes, and
     * every other file in the directory still cannot, which is what the sweep in the first describe
     * block enforces by naming the files with hits. The read-only guarantee did not move into a
     * comment when the writes arrived; it moved into the encoder, which has no publish.
     */
    expect(MQTT_SEAM_HOLDINGS.sparkplug.guardedWriteSites).toEqual([
      "src/lib/db/providers/industrial/sparkplug/session.ts",
    ]);
    expect(MQTT_SEAM_HOLDINGS.sparkplug.allowedWriteSites).toBe(5);
    expect(heldByAnotherMqttGuard("src/lib/db/providers/industrial/sparkplug/decode.ts")).toBe(true);
    // The writing file is held by this row too, so it cannot fall to the default guard.
    expect(heldByAnotherMqttGuard("src/lib/db/providers/industrial/sparkplug/session.ts")).toBe(true);
  });
});
