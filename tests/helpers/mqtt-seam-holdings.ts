/**
 * Which files each MQTT seam guard holds, in one place.
 *
 * The shape is `tests/helpers/grpc-seam-holdings.ts`, which solved the same problem for the three
 * gRPC providers: one guard is the repository-wide default and every other provider's guard reads
 * its own row from here, so "the files one guard holds" and "the files the default guard skips"
 * are the same list by construction. Its header states the rule this file inherits: a new provider
 * adds its row here and edits no other provider's guard.
 *
 * WHY THIS FILE EXISTS, stated honestly, because an earlier version of this note had it wrong.
 *
 * `tests/unit/db/mqtt/outbound.test.ts` builds the directory it sweeps by hand:
 *
 *     const dir = path.join(import.meta.dir, "..", "..", "..", "..",
 *                           "src", "lib", "db", "providers", "keyvalue", "mqtt");
 *
 * The first claim made about that line was that moving the transport to `src/lib/db/mqtt/` would
 * leave the sweep pointing at a directory that no longer holds it, so the test would stay green
 * while guarding nothing. THAT CLAIM WAS WRONG, and it was wrong in the direction that matters:
 * it overstated the danger. MEASURED on 2026-10-13 by copying the eight files of the current
 * directory, removing the four the move would take (`session.ts`, `valve.ts`, `encoder.ts`,
 * `constants.ts`) and running the test's own sweep logic against both layouts:
 *
 * | layout | `files.length > 4` | `.write(` sites, expected 1 | `session.ts` read |
 * |---|---|---|---|
 * | today, eight files | passes | 1, passes | guarded line found |
 * | after the move, four files | FAILS (4) | FAILS (0) | THROWS ENOENT |
 *
 * So the test fails loudly, from three assertions at once. It does not fail silently.
 *
 * The real reason to hold the paths in a record is narrower, and it is about ownership rather than
 * safety: the hard-coded path lives in `outbound.test.ts`, which belongs to the shipped `mqtt`
 * provider. Without this file, every future MQTT provider has to edit that shared test to widen
 * the sweep, and two providers doing it in the same week conflict in it. With this file, the sweep
 * reads its directories from one record, and a second MQTT provider adds a row and touches nothing
 * of `mqtt`'s. That also keeps the preparatory pull request's promise literally true: what changes
 * in `mqtt`'s test is where it reads its paths from, and nothing about what the product does.
 *
 * One thing worth copying from `outbound.test.ts` rather than reinventing: it strips comments
 * before counting `.write(`, so a doc comment naming the rule is not mistaken for a call site.
 * Three separate scans in this project have since produced wrong numbers by counting prose as
 * code, so the stripping is a load-bearing detail, not a nicety.
 *
 * NOT YET ADOPTED. `outbound.test.ts` still builds its directory by hand; pointing it at this
 * record means editing a file that belongs to the shipped `mqtt` provider, which is a shared file
 * under the ordering rule. This record and its test stand on their own until that edit is
 * scheduled: the test already holds the record equal to what the current guard sweeps, so the
 * two cannot drift apart while they wait.
 */

/** One MQTT seam guard's share of the repository. */
export interface MqttSeamHolding {
  /**
   * Files this row's own guard holds. The default guard skips them, exactly as the gRPC rows do.
   * Empty for the row whose guard IS the repository-wide default.
   */
  readonly held: readonly RegExp[];
  /**
   * The directories whose top-level `.ts` files the outbound sweep reads for `.write(`.
   *
   * A list rather than a single path, because after the transport is extracted the guarded write
   * lives in one directory and the provider's own modules in another, and the sweep has to cover
   * both or it stops being a proof. Relative to the repository root.
   */
  readonly sweptDirectories: readonly string[];
  /**
   * How many `.write(` call sites the swept directories may hold in total, comments stripped.
   *
   * One today: the guarded write in the transport's `session.ts`. A row that declares more than
   * one has to say which file each site is in, in `guardedWriteSites`.
   */
  readonly allowedWriteSites: number;
  /**
   * Each permitted write site as `<path>`, so the count above cannot be satisfied by a write
   * somewhere else. The sweep checks the count AND that every site sits in one of these files.
   */
  readonly guardedWriteSites: readonly string[];
  /** The source files of this row that import the shared MQTT transport, held exactly. */
  readonly transportImporters: readonly string[];
  /** The provider directory this row's own checks read; absent for the transport row. */
  readonly providerDirectory?: string;
}

/**
 * The rows as they stand BEFORE the transport is extracted, so the record can be adopted without
 * waiting for the move: `mqtt`'s row describes today's single directory, and the transport row is
 * present but empty until the preparatory pull request fills it.
 *
 * After the move, `transport.sweptDirectories` becomes `["src/lib/db/mqtt"]`, its
 * `guardedWriteSites` becomes `["src/lib/db/mqtt/session.ts"]`, and `mqtt`'s row keeps its own
 * directory with `allowedWriteSites: 0`. A new MQTT provider's row looks like `sparkplug`'s below.
 *
 * A row's `sweptDirectories` names only directories that EXIST. The first draft of this record had
 * `sparkplug` naming its directory before the family was created, and the test below caught it:
 * a sweep over a directory that is not there throws rather than guarding anything.
 */
export const MQTT_SEAM_HOLDINGS: Readonly<Record<string, MqttSeamHolding>> = Object.freeze({
  transport: {
    held: [/^src\/lib\/db\/mqtt\//, /^tests\/unit\/db\/mqtt\/transport\//, /^tests\/helpers\/mqtt-/],
    // Empty until the extraction lands; `mqtt`'s row carries the guarded write today.
    sweptDirectories: [],
    allowedWriteSites: 0,
    guardedWriteSites: [],
    transportImporters: [],
  },
  mqtt: {
    held: [],
    sweptDirectories: ["src/lib/db/providers/keyvalue/mqtt"],
    allowedWriteSites: 1,
    guardedWriteSites: ["src/lib/db/providers/keyvalue/mqtt/session.ts"],
    transportImporters: [],
    providerDirectory: "src/lib/db/providers/keyvalue/mqtt",
  },
  /**
   * The Sparkplug row, which is what this file is for. It declares no write site at all: the
   * provider reaches a broker only through the shared transport, so a `.write(` anywhere under its
   * directory is the thing the guard exists to catch (SP-S1).
   *
   * Its directory is written as it will be, under the industrial family. The directory is not
   * created by this session: the family is born when the OPC UA pull request merges (K-01), and
   * this row is inert until a path matches it.
   */
  sparkplug: {
    held: [
      /^src\/lib\/db\/providers\/industrial\/sparkplug\//,
      /^tests\/unit\/db\/sparkplug\//,
      /^tests\/helpers\/sparkplug-/,
      /^tests\/live\/sparkplug-/,
    ],
    // Filled in once the family directory existed. The invariant its test holds runs both ways: a
    // row may not name a directory that is not there, AND a directory that appears may not stay
    // unswept. This row sat empty while the family was pending and the test required it to; the
    // directory arrived with the OPC UA merge and the same test then required this line.
    sweptDirectories: ["src/lib/db/providers/industrial/sparkplug"],
    /*
     * FIVE WRITES, AND THE GUARANTEE CHANGED SHAPE RATHER THAN WEAKENING.
     *
     * This row said zero for as long as the provider was going to reach a broker through a shared
     * transport. A coordination decision then had it write its own session, after this session
     * measured that the shipped read returns one row per topic while a Sparkplug read needs the
     * order of successive messages on one topic. So writes live here now, and the record says so
     * rather than being quietly satisfied: its own test turned red the moment `session.ts` landed,
     * which is the invariant working.
     *
     * The five are the whole of what a bounded read sends: connect, subscribe, ping, unsubscribe,
     * disconnect. What makes this at least as strong as zero is not the count but what the bytes
     * are: every one of the five is handed a value produced by `encoder.ts`, which has no function
     * that writes a PUBLISH. A sixth write, or a write passed bytes from anywhere else, fails the
     * guard. So the claim moved from "this directory cannot write" to "this directory can only
     * write what a module that cannot produce a publish produced", which is the claim the product
     * actually needs.
     */
    allowedWriteSites: 5,
    guardedWriteSites: ["src/lib/db/providers/industrial/sparkplug/session.ts"],
    transportImporters: [],
    providerDirectory: "src/lib/db/providers/industrial/sparkplug",
  },
});

/** Whether a repository path is held by a guard other than the default: any row's `held` matches. */
export function heldByAnotherMqttGuard(path: string): boolean {
  return Object.values(MQTT_SEAM_HOLDINGS).some((holding) => holding.held.some((pattern) => pattern.test(path)));
}

/** Every directory the outbound sweep must read, across all rows, with no duplicates. */
export function allSweptDirectories(): readonly string[] {
  const seen = new Set<string>();
  for (const holding of Object.values(MQTT_SEAM_HOLDINGS)) {
    for (const dir of holding.sweptDirectories) seen.add(dir);
  }
  return Object.freeze([...seen].sort());
}

/** Every `.write(` site the repository permits behind the MQTT seam, across all rows. */
export function allGuardedWriteSites(): readonly string[] {
  const seen = new Set<string>();
  for (const holding of Object.values(MQTT_SEAM_HOLDINGS)) {
    for (const site of holding.guardedWriteSites) seen.add(site);
  }
  return Object.freeze([...seen].sort());
}
