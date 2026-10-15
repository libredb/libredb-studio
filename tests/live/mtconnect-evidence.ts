/**
 * Captures the fixture agent's own answers into `tests/fixtures/mtconnect/`.
 *
 * The integration test replays these through the real provider, so what it reads is XML an
 * MTConnect agent produced rather than XML this repository wrote. Run it with the compose fixture
 * up:
 *
 *   docker compose -f database-compose.yml up -d mtconnect mtconnect-adapter
 *   bun tests/live/mtconnect-evidence.ts
 *
 * Each capture is written VERBATIM, byte for byte as the agent sent it: this provider refuses an
 * XML comment by rule, so a request line written into the document would make every replay refuse.
 * The request that produced each capture is listed in `tests/fixtures/mtconnect/README.md`, which
 * this script writes too.
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ORIGIN = process.env.MTCONNECT_ORIGIN ?? "http://127.0.0.1:17322";
const OUT = join(import.meta.dir, "..", "fixtures", "mtconnect");
const ROOT = join(import.meta.dir, "..", "..");

/**
 * The image the fixture pins, read from `database-compose.yml` rather than typed here, so the
 * README these captures carry their provenance in cannot drift from the service that produced them.
 * `tests/integration/db/mtconnect-provider.test.ts` holds all three together: this pin, the agent
 * version the captures' own Header reports, and the README below.
 */
const pinnedImage = (): string => {
  const compose = readFileSync(join(ROOT, "database-compose.yml"), "utf-8");
  const found = /image:\s*(mtconnect\/agent:[\d.]+@sha256:[a-f0-9]{64})/.exec(compose);
  if (found === null) throw new Error("database-compose.yml pins no mtconnect/agent image");
  return found[1] as string;
};

const sequenceOf = (xml: string, key: string): number => {
  const found = new RegExp(`${key}="(\\d+)"`).exec(xml);
  if (found === null) throw new Error(`${key} is missing from a Header this capture needs it from`);
  return Number(found[1]);
};

/**
 * The roots an agent answers a request in this script with, MEASURED over the captures this script
 * produced: `MTConnectDevices` for `/probe`, `MTConnectStreams` for `/current` and `/sample`,
 * `MTConnectAssets` for `/assets` and `/asset/...`, and `MTConnectError` for the out-of-range read.
 * A body with no such root is not an answer this script may keep.
 */
const DOCUMENT_ROOTS = ["MTConnectDevices", "MTConnectStreams", "MTConnectAssets", "MTConnectError"];

/**
 * The bound on one capture.
 *
 * MEASURED on the captures in `tests/fixtures/mtconnect/`: the largest is `current.xml` at 4,789
 * bytes and every one of the twenty-two begins with `<?xml`. 256 KiB is far above the largest and
 * far below anything that would matter on disk, so the bound costs a real capture nothing and still
 * means this script cannot be told to write an arbitrary amount of someone else's bytes into the
 * fixture set.
 */
const MAX_CAPTURE_BYTES = 262144;

/**
 * Reads one answer, and refuses to hand back anything this script should not write down.
 *
 * The three checks are not about an agent misbehaving. They are about this script being pointed at
 * the wrong thing: `MTCONNECT_ORIGIN` is an environment variable, the port is one digit away from
 * other services, and a body that is HTML or empty would otherwise be written into the fixture set
 * verbatim and replayed by the integration test as though an agent had sent it. Checking here
 * rather than in `save` is deliberate: every capture and every number in the README comes through
 * this function, so one check covers both writes.
 */
const get = async (request: string): Promise<string> => {
  const answer = await fetch(`${ORIGIN}${request}`);
  const body = await answer.text();
  if (!answer.ok && !request.includes("999999999")) {
    throw new Error(`${request} answered ${answer.status}, and this capture needs an answer`);
  }
  if (body.length > MAX_CAPTURE_BYTES) {
    throw new Error(
      `${request} answered ${body.length} bytes, past the ${MAX_CAPTURE_BYTES} a capture may be. Is ${ORIGIN} an MTConnect agent?`,
    );
  }
  if (!body.startsWith("<?xml")) {
    throw new Error(
      `${request} answered something that does not begin with an XML declaration. Is ${ORIGIN} an MTConnect agent?`,
    );
  }
  const root = DOCUMENT_ROOTS.find((name) => body.includes(`<${name}`));
  if (root === undefined) {
    throw new Error(
      `${request} answered XML whose root is none of ${DOCUMENT_ROOTS.join(", ")}. Is ${ORIGIN} an MTConnect agent?`,
    );
  }
  return body;
};

const taken: { name: string; request: string; bytes: number }[] = [];

const save = async (name: string, request: string, body: string): Promise<void> => {
  await writeFile(join(OUT, name), body, "utf-8");
  taken.push({ name, request, bytes: body.length });
  console.log(`${name.padEnd(28)} ${String(body.length).padStart(6)} bytes  GET ${request}`);
};

await mkdir(OUT, { recursive: true });

const current = await get("/current");
const last = sequenceOf(current, "lastSequence");
// Two sequences inside the buffer, chosen from the capture rather than typed, so the numbers the
// test asserts are the ones this agent really served.
const at = last - 5;
const from = last - 8;

await save("probe.xml", "/probe", await get("/probe"));
await save("current.xml", "/current", current);
await save("current-at.xml", `/current?at=${at}`, await get(`/current?at=${at}`));
await save("sample-from.xml", `/sample?from=${from}&count=5`, await get(`/sample?from=${from}&count=5`));
// The health read, whose Header reports the window of its own answer rather than the buffer's.
// The integration test holds this difference, because reading the window from here is the defect
// that refused every `at` and every `from` above 2.
await save("sample-count-1.xml", "/sample?count=1", await get("/sample?count=1"));
await save("sample-count-minus.xml", "/sample?count=-5", await get("/sample?count=-5"));
await save("assets.xml", "/assets", await get("/assets"));
await save("asset-tool.xml", "/asset/TOOL-1722", await get("/asset/TOOL-1722"));
const condition = `/current?path=${encodeURIComponent('//DataItem[@category="CONDITION"]')}`;
await save("current-condition.xml", condition, await get(condition));

const first = sequenceOf(current, "firstSequence");
const next = sequenceOf(current, "nextSequence");
await writeFile(
  join(OUT, "README.md"),
  [
    "# MTConnect captures",
    "",
    "Taken by `tests/live/mtconnect-evidence.ts` from the compose fixture (`mtconnect` and",
    "`mtconnect-adapter` in `database-compose.yml`). Each file is the agent's answer verbatim: this",
    "provider refuses an XML comment, so nothing may be written into the documents themselves.",
    "",
    `Taken from \`${pinnedImage()}\`, whose Header reports version`,
    // From the Header element, not from the document: the XML declaration carries a `version="1.0"`
    // that a looser pattern reads first, which is what the first draft of this line did.
    `\`${/<Header[^>]*\sversion="([\d.]+)"/.exec(current)?.[1] ?? "unknown"}\`.`,
    "",
    `The buffer at capture time: firstSequence ${first}, lastSequence ${last}, nextSequence ${next}.`,
    "",
    "| file | request | bytes |",
    "|---|---|---|",
    ...taken.map((one) => `| \`${one.name}\` | \`GET ${one.request}\` | ${one.bytes} |`),
    "",
  ].join("\n"),
  "utf-8",
);
console.log(`\nbuffer: firstSequence=${first} lastSequence=${last} nextSequence=${next}`);
console.log(`at=${at} and from=${from} are inside that window; the test pins both.`);
