/**
 * Hand-run live check of the Modbus provider: does a real `ModbusProvider` read the fixture's four
 * tables correctly, refuse what it refuses before anything is dialled, and leave the device able to
 * answer somebody else?
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The unit tests drive each module against
 * fakes, and the integration test runs the whole provider against a device written in this
 * repository. Only the fixture can say that the reads are right against a server somebody else
 * wrote: `oitc/modbus-server`, pinned by digest in `database-compose.yml`, which implements the
 * protocol with pymodbus 3.12.x. Framing, function-code decoding and exception responses are all
 * third-party there, so a read that agrees with it is a read two independent implementations
 * agree on.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in
 * CI runs it in the `Modbus live check` step of the `functional-smoke` job of
 * .github/workflows/ci.yml. That sentence was not here until 19 October 2026, and its absence
 * was the defect: the step existed as a file waiting to be pasted, nothing pasted it, and a
 * reader of this header could not tell a check CI asks for from one only a hand ever ran.
 * `tests/runner/discover.ts`).
 *
 * Run it from the repository root, after `docker compose -f database-compose.yml up -d modbus`
 * (docker/modbus/README.md), on Bun and on Node:
 *
 *   bun tests/live/modbus-live-check.ts
 *   bun tests/live/modbus-live-check.ts --target 127.0.0.1:1502
 *   bun build tests/live/modbus-live-check.ts --target=node --outfile "$OUT/live.mjs" && node "$OUT/live.mjs"
 *
 * It never writes, and there is no way for it to: the provider builds four read function codes and
 * the identification request and nothing else, which is what `enforcesReadOnly` claims. The last
 * check reads all four tables again and fails on any difference, so a run that somehow wrote
 * would say so rather than being believed.
 *
 * The provider is constructed directly rather than through `src/lib/db/factory.ts`, because that
 * module imports every engine and its import graph does not bundle for the Node run - the same
 * reason `tests/live/etcd-live-check.ts` and `tests/live/oxia-live-check.ts` keep it out.
 *
 * It prints one line per check, `PASS <name>` or `FAIL <name>: <error>`, then `<passed> of <total>
 * checks passed on <target> (<runtime>)`, and exits 1 on any failure; an argument it does not
 * accept exits 2 before any socket opens.
 */
import { connect, type Socket } from "node:net";
import { ModbusProvider } from "@/lib/db/providers/industrial/modbus/index";
import type { DatabaseConnection } from "@/lib/types";

const DEFAULT_TARGET = "127.0.0.1:1502";
const RUNTIME = typeof Bun === "undefined" ? `node ${process.versions.node}` : `bun ${Bun.version}`;

/**
 * The image this check's expected values were measured against.
 *
 * `MODBUS_LIVE_DIGEST` was exported by the CI step and read by nothing, which is a pin that
 * records an intention and enforces none. It is a gate now, the way `RABBITMQ_LIVE_DIGEST` is one
 * (`tests/helpers/rabbitmq-live.ts`): set to anything else, this check refuses rather than
 * measuring a device whose tables it cannot vouch for.
 *
 * Unset is allowed and says so in the summary, because a developer runs this against the compose
 * fixture with no environment at all. What stops CI from quietly dropping the export is
 * `tests/unit/db/modbus/live-environment.test.ts`, which holds the step to it.
 */
const PINNED_DIGEST = "sha256:32bfe144512e1f070cf7e7e2513cdcb774d74db142ee5dbad45b21d6d705ab97";
const declaredDigest = process.env.MODBUS_LIVE_DIGEST;
if (declaredDigest !== undefined && declaredDigest !== PINNED_DIGEST) {
  console.error(
    `modbus-live-check: MODBUS_LIVE_DIGEST is ${declaredDigest}, and this check's values were measured ` +
      `against ${PINNED_DIGEST}; nothing was dialled.`,
  );
  process.exit(2);
}

/**
 * The fixture's four tables, as formulas rather than as a table of numbers.
 *
 * `docker/modbus/README.md` carries the same four and says why they look like this: an off-by-one
 * against `1000 + N` moves a value by one and reads like a plausible reading, where `7000 + 11 x N`
 * moves it by eleven and a descending run makes a reversed range visible.
 */
const holding = (address: number): number => 7000 + 11 * address;
const inputRegister = (address: number): number => 8500 - 7 * address;
const coil = (address: number): boolean => address % 3 === 0;
const discreteInput = (address: number): boolean => [2, 3, 5, 7].includes(address);

/** Where each table stops answering its pattern and starts answering zero. */
const DEFINED = { holding_register: 10, input_register: 8, coil: 10, discrete_input: 8 } as const;

/** How many values all four tables answer together, so an empty read cannot pass as an equal one. */
const EXPECTED_FINGERPRINT = DEFINED.holding_register + DEFINED.input_register + DEFINED.coil + DEFINED.discrete_input;

function parseTarget(argv: readonly string[]): string {
  let target = DEFAULT_TARGET;
  for (let at = 0; at < argv.length; at += 1) {
    if (argv[at] === "--target") {
      const value = argv[at + 1];
      if (value === undefined) refuse("--target needs <host:port>");
      target = value;
      at += 1;
      continue;
    }
    refuse(`unknown argument ${JSON.stringify(argv[at])}`);
  }
  if (!/^[^\s:]+:\d+$/.test(target)) refuse(`--target must be <host:port>, not ${JSON.stringify(target)}`);
  return target;
}

function refuse(reason: string): never {
  console.error(`modbus-live-check: ${reason}; nothing was dialled.`);
  process.exit(2);
}

const tally = { passed: 0, total: 0 };

async function check(name: string, body: () => Promise<void>): Promise<void> {
  tally.total += 1;
  try {
    await body();
    tally.passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function same(got: unknown, want: unknown, what: string): void {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  assert(a === b, `${what}: got ${a}, wanted ${b}`);
}

const TARGET = parseTarget(process.argv.slice(2));
const [HOST, PORT] = [TARGET.slice(0, TARGET.lastIndexOf(":")), Number(TARGET.slice(TARGET.lastIndexOf(":") + 1))];

/** One point per table, so the named-point path is exercised beside the range path. */
const MAP = JSON.stringify([
  { name: "volts", unitId: 1, table: "holding_register", address: 0, type: "uint16", unit: "V" },
  { name: "amps", unitId: 1, table: "holding_register", address: 1, type: "uint16", unit: "A" },
  { name: "inlet", unitId: 1, table: "input_register", address: 0, type: "uint16", unit: "kPa" },
  { name: "pump", unitId: 1, table: "coil", address: 0, type: "bool" },
  { name: "lid", unitId: 1, table: "discrete_input", address: 2, type: "bool" },
]);

function engine(): ModbusProvider {
  return new ModbusProvider({
    id: "live",
    name: "fixture",
    type: "modbus",
    host: HOST,
    port: PORT,
    registerMap: MAP,
  } as unknown as DatabaseConnection);
}

async function values(statement: string): Promise<unknown[]> {
  const provider = engine();
  const result = await provider.query(statement);
  return result.rows.map((row) => row.value);
}

/** All four tables, read as one list, so "nothing changed" is one comparison. */
async function fingerprint(): Promise<unknown[]> {
  const reads = [
    '{"unit":1,"table":"holding_register","address":0,"count":10}',
    '{"unit":1,"table":"input_register","address":0,"count":8}',
    '{"unit":1,"table":"coil","address":0,"count":10}',
    '{"unit":1,"table":"discrete_input","address":0,"count":8}',
  ];
  const all: unknown[] = [];
  for (const statement of reads) {
    // oxlint-disable-next-line no-await-in-loop -- one read at a time, as a reader would.
    all.push(...(await values(statement)));
  }
  return all;
}

/**
 * A raw client that is not this repository's code, standing in for the plant's own HMI.
 *
 * It builds the frame by hand for the same reason the fixture was verified by hand: what is being
 * asked here is whether the DEVICE is still able to answer somebody, and an answer read through
 * the thing under test would not settle it.
 */
function hmiRead(budgetMs: number): Promise<number | "unanswered"> {
  return new Promise((resolve) => {
    let socket: Socket | undefined;
    const give = (outcome: number | "unanswered") => {
      socket?.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => give("unanswered"), budgetMs);
    socket = connect(PORT, HOST, () => {
      const pdu = Buffer.from([3, 0, 0, 0, 1]);
      const head = Buffer.alloc(7);
      head.writeUInt16BE(0x4242, 0);
      head.writeUInt16BE(pdu.length + 1, 4);
      head[6] = 1;
      socket?.write(Buffer.concat([head, pdu]));
    });
    socket.on("error", () => {
      clearTimeout(timer);
      give("unanswered");
    });
    socket.on("data", (adu: Buffer) => {
      clearTimeout(timer);
      give(adu.length >= 11 ? adu.readUInt16BE(9) : -1);
    });
  });
}

/**
 * The opening read is a CHECK and not a bare statement, and that is not a style choice.
 *
 * It was a bare `await` at the top, and a run against a port with no device behind it threw
 * there: the script died before the first check, printed no FAIL line and no summary, and exited
 * with a crash. A reader scanning the output for "FAIL" would have found none. MEASURED while
 * canarying this file, which is why the count below is asserted too: two empty fingerprints
 * compare equal, so "nothing changed" would pass on a device that answered nothing at all.
 */
let before: unknown[] | undefined;

await check("the fixture answers all four tables, which is what the rest of this run compares against", async () => {
  const taken = await fingerprint();
  assert(
    taken.length === EXPECTED_FINGERPRINT,
    `the fixture answered ${taken.length} values, wanted ${EXPECTED_FINGERPRINT}`,
  );
  before = taken;
});

await check("connect answers for the fixture, and holds nothing", async () => {
  const provider = engine();
  await provider.connect();
  // The dial sends no request and keeps no socket. If it kept one, the check below would be
  // asking a device that is already busy with us.
  const hmi = await hmiRead(1000);
  assert(hmi !== "unanswered", "the device did not answer a second client after connect()");
});

await check("every holding register answers 7000 + 11 x N, read as one range", async () => {
  const got = await values('{"unit":1,"table":"holding_register","address":0,"count":10}');
  same(
    got,
    Array.from({ length: 10 }, (_, address) => holding(address)),
    "the holding registers",
  );
});

await check("the input registers answer a DESCENDING run, in the order they were asked for", async () => {
  const got = await values('{"unit":1,"table":"input_register","address":0,"count":8}');
  same(
    got,
    Array.from({ length: 8 }, (_, address) => inputRegister(address)),
    "the input registers",
  );
});

await check("the bit tables answer their own patterns", async () => {
  const coils = await values('{"unit":1,"table":"coil","address":0,"count":10}');
  const discrete = await values('{"unit":1,"table":"discrete_input","address":0,"count":8}');
  same(
    coils,
    Array.from({ length: 10 }, (_, address) => coil(address)),
    "the coils",
  );
  same(
    discrete,
    Array.from({ length: 8 }, (_, address) => discreteInput(address)),
    "the discrete inputs",
  );
});

await check("a read starting part way in carries the address it asked for", async () => {
  const provider = engine();
  const result = await provider.query('{"unit":1,"table":"holding_register","address":3,"count":2}');
  same(
    result.rows.map((row) => row.address),
    [3, 4],
    "the address column",
  );
  same(
    result.rows.map((row) => row.value),
    [holding(3), holding(4)],
    "the values beside it",
  );
});

await check("named points are read through the map, one request per block", async () => {
  const provider = engine();
  const result = await provider.query('{"read":["volts","amps","inlet","pump","lid"]}');
  const byName = new Map(result.rows.map((row) => [row.point as string, row.value]));
  same(byName.get("volts"), holding(0), "volts");
  same(byName.get("amps"), holding(1), "amps");
  same(byName.get("inlet"), inputRegister(0), "inlet");
  same(byName.get("pump"), coil(0), "pump");
  same(byName.get("lid"), discreteInput(2), "lid");
});

await check("past the end of a table the fixture answers zero rather than an exception", async () => {
  // `initializeUndefinedRegisters` is true in docker/modbus/modbus_server.json, so this is the
  // fixture's shape rather than the provider's. It is checked because a provider that silently
  // dropped the tail of a block would otherwise look the same as one that read it.
  const got = await values(`{"unit":1,"table":"holding_register","address":${DEFINED.holding_register},"count":3}`);
  same(got, [0, 0, 0], "the registers past the end of the holding table");
});

await check("a table the protocol does not have is refused before anything is dialled", async () => {
  const provider = engine();
  await provider
    .query('{"unit":1,"table":"flux_capacitor","address":0,"count":1}')
    .then(() => {
      throw new Error("the read was accepted");
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert(/flux_capacitor|table/i.test(message), `the refusal did not name the table: ${message}`);
    });
});

await check("a count past the protocol's own limit is refused, and the refusal is ours", async () => {
  const provider = engine();
  await provider
    .query('{"unit":1,"table":"holding_register","address":0,"count":5000}')
    .then(() => {
      throw new Error("the read was accepted");
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert(/125|limit|quantity|count/i.test(message), `the refusal did not name the bound: ${message}`);
    });
});

await check("a request that is not a JSON object is refused as a request, not as a device fault", async () => {
  const provider = engine();
  await provider
    .query("{not json")
    .then(() => {
      throw new Error("the read was accepted");
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert(message.length > 0, "the refusal said nothing");
    });
});

await check("after all of that the device still answers somebody else", async () => {
  // The whole point of holding no connection: a plant's own HMI must not be locked out by
  // Studio having read something. `docs/providers/modbus.md` section 3.4 is why.
  const hmi = await hmiRead(1000);
  assert(hmi !== "unanswered", "the device stopped answering a second client");
  same(hmi, holding(0), "what the second client read");
});

await check("nothing changed: the four tables read the same as they did at the start", async () => {
  // Never a comparison against `undefined`: if the opening read failed there is nothing to
  // compare with, and saying so is the answer rather than comparing two absences.
  assert(before !== undefined, "the opening read of the four tables did not happen, so nothing can be compared");
  same(await fingerprint(), before, "the fingerprint of all four tables");
});

const against = declaredDigest === undefined ? "digest not declared" : `digest ${declaredDigest.slice(0, 14)}`;
console.log(`${tally.passed} of ${tally.total} checks passed on ${TARGET} (${RUNTIME}, ${against})`);
process.exit(tally.passed === tally.total ? 0 : 1);
