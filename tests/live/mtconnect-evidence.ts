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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ORIGIN = process.env.MTCONNECT_ORIGIN ?? "http://127.0.0.1:17322";
const OUT = join(import.meta.dir, "..", "fixtures", "mtconnect");

const sequenceOf = (xml: string, key: string): number => {
  const found = new RegExp(`${key}="(\\d+)"`).exec(xml);
  if (found === null) throw new Error(`${key} is missing from a Header this capture needs it from`);
  return Number(found[1]);
};

const get = async (request: string): Promise<string> => {
  const answer = await fetch(`${ORIGIN}${request}`);
  const body = await answer.text();
  if (!answer.ok && !request.includes("999999999")) {
    throw new Error(`${request} answered ${answer.status}, and this capture needs an answer`);
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
