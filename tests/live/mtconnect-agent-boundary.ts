/**
 * Captures the MTConnect agent path's boundary on the pinned compose fixture into `boundary.json`, for
 * `docs/providers/mtconnect.md` section 14. Run by `tests/fixtures/mtconnect/2.8.0.4/agent-boundary/run.sh`, which
 * starts the fixture's adapter and two agents of the pinned image, one with the fixture's own `AllowPut = false` and
 * one with `AllowPut = true`, and removes all three after.
 *
 * What it records:
 *   reads             what each admitted agent read answered through a real `MTConnectProvider` on the agent profile,
 *                     and every request it sent (method, path and query), read through a transport that records them;
 *   refusedBeforeSend each refused agent request's opening words, and how many requests it sent (0);
 *   surfaces          what the agent-mode handle's tree and other readings answered, and the requests they sent;
 *   raw               what each agent did with a PUT and a POST of an observation, a GET of `/cancel/id=1` and its
 *                     Swagger document, sent by THIS script with `fetch` and never by Studio, and whether the value
 *                     each targeted changed;
 *   state             the agent's buffer before and after the agent reads: every observation in between, by data item,
 *                     so a sequence that moved is shown to have moved by the machine's own observations alone.
 *
 * The fixture has no credential, and the capture holds none; it holds no host name either: the adapter's address
 * appears only as whether an answer carried it. Both are checked before the file is written.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createNodeTransport, type NodeRequest } from "@/lib/db/http/node-transport";
import { MTConnectProvider } from "@/lib/db/providers/industrial/mtconnect/index";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const PORT = Number(process.env.MTCONNECT_AGENT_PORT ?? "17393");
const PUT_PORT = Number(process.env.MTCONNECT_AGENT_PUT_PORT ?? "17394");
const OUT = process.env.MTCONNECT_AGENT_OUT ?? ".";
const IMAGE = "mtconnect/agent:2.8.0.4@sha256:c42f90850ab70d65ae5e73b14392b3041ed51065bd7bf287658db6f7260df641";
const LATHE = "LIBREDB-LATHE-1722";
/** The adapter's address as the agent writes it, which no agent answer may carry. */
const ADAPTER = /mtconnect-adapter/i;
const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 10_000, maxResultRows: 200, maxResultBytes: 1_000_000 };

const sent: string[] = [];

const requestLine = (request: NodeRequest): string => {
  const url = new URL(request.url);
  return `${request.method} ${url.pathname}${url.search}`;
};

function provider(port: number, readOnly: boolean): MTConnectProvider {
  const connection = {
    id: "mtc-agent-boundary",
    name: "mtconnect agent boundary",
    type: "mtconnect",
    host: "127.0.0.1",
    port,
  } as DatabaseConnection;
  return new MTConnectProvider(connection, {}, readOnly ? { readOnly: true, sendsStatements: true } : {}, (options) => {
    const transport = createNodeTransport(options);
    return {
      request: (request) => {
        sent.push(requestLine(request));
        return transport.request(request);
      },
      close: () => transport.close(),
    };
  });
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A refusal's first sentence: up to the first full stop that ends a sentence, not one inside a route or a list. */
const firstSentence = (message: string): string => /^[\s\S]*?\.(?=\s|$)/.exec(message)?.[0] ?? message;

/** The buffer's next sequence, read raw. */
async function nextSequence(port: number): Promise<number> {
  const text = await (await fetch(`http://127.0.0.1:${port}/current`)).text();
  return Number(/nextSequence="(\d+)"/.exec(text)?.[1]);
}

/** The data items of every observation from `from` on, read raw. */
async function observationsSince(port: number, from: number): Promise<string[]> {
  const text = await (await fetch(`http://127.0.0.1:${port}/sample?from=${from}&count=1000`)).text();
  return [...text.matchAll(/dataItemId="([^"]+)"/g)].map((match) => match[1].replace(ADAPTER, "<adapter>"));
}

/** One observation's value, read raw. */
async function valueOf(port: number, dataItemId: string): Promise<string> {
  const text = await (await fetch(`http://127.0.0.1:${port}/${LATHE}/current`)).text();
  return new RegExp(`dataItemId="${dataItemId}"[^>]*>([^<]*)<`).exec(text)?.[1] ?? "";
}

/** A raw request the capture script sends on its own, recorded by its status and the agent's error code. */
async function raw(port: number, method: string, target: string, item?: string) {
  const before = item === undefined ? undefined : await valueOf(port, item);
  const answer = await fetch(`http://127.0.0.1:${port}${target}`, { method });
  const text = await answer.text();
  const after = item === undefined ? undefined : await valueOf(port, item);
  return {
    request: `${method} ${target}`,
    status: answer.status,
    errorCode: /errorCode="([A-Z_]+)"/.exec(text)?.[1] ?? null,
    ...(item === undefined ? {} : { valueChanged: before !== after }),
  };
}

async function swaggerOperations(port: number): Promise<Record<string, number>> {
  const text = await (await fetch(`http://127.0.0.1:${port}/swagger`)).text();
  const counts: Record<string, number> = {};
  for (const match of text.matchAll(/"(get|put|post|delete)"\s*:/g)) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
  return counts;
}

const READS = [
  "/probe",
  `/${LATHE}/probe`,
  "/current",
  `/${LATHE}/current`,
  '/current?path=//DataItem[@id="x1722-pos"]',
  "/current?path=//Adapter",
  "/sample?count=-5",
  `/${LATHE}/sample?path=//DataItem[@type="POSITION"]&count=-3`,
  "/assets",
  `/${LATHE}/assets`,
  "/asset/TOOL-1722",
] as const;

const REFUSED = [
  "PUT /probe",
  `POST /${LATHE}?x1722-pos=9999`,
  "DELETE /asset/TOOL-1722",
  "/cancel/id=1",
  "/assets/TOOL-1722",
  "/swagger",
  "/sample?interval=1000",
  "/current?heartbeat=1000",
  "/sample?frequency=1000",
  "/current\n/sample",
  "/../probe",
  "/asset/..",
  "/current?path=count(//DataItem)",
  "/sample?count=201",
] as const;

const agent = provider(PORT, true);
await agent.connect();
const connectSent = sent.splice(0);

const startSequence = await nextSequence(PORT);
const reads = [];
for (const statement of READS) {
  try {
    const result = await agent.queryReadOnly(statement, BUDGET);
    reads.push({
      statement,
      sent: sent.splice(0),
      rowCount: result.rowCount,
      fields: result.fields,
      withheld: result.warnings?.map((warning) => firstSentence(warning.message)) ?? [],
      carriesAdapterAddress: ADAPTER.test(JSON.stringify(result.rows)),
    });
  } catch (error) {
    reads.push({ statement, sent: sent.splice(0), refused: firstSentence(messageOf(error)) });
  }
}
const endSequence = await nextSequence(PORT);

const refusedBeforeSend = [];
for (const statement of REFUSED) {
  try {
    await agent.queryReadOnly(statement, BUDGET);
    refusedBeforeSend.push({ statement, answered: true, sent: sent.splice(0) });
  } catch (error) {
    refusedBeforeSend.push({ statement, refused: firstSentence(messageOf(error)), sent: sent.splice(0) });
  }
}

const surfaces: Record<string, unknown> = {};
const devices = (await agent.listContainers()).map((container) => container.name);
surfaces.devices = devices;
surfaces.agentDeviceCounts = await agent.countObjects(["Agent"]);
surfaces.agentDeviceItems = (await agent.listObjects(["Agent"], "dataitem")).map((object) => object.path[1]);
for (const reading of ["getHealth", "getOverview", "getActiveSessions"] as const) {
  try {
    await agent[reading]();
    surfaces[reading] = "answered";
  } catch (error) {
    surfaces[reading] = messageOf(error);
  }
}
surfaces.sent = sent.splice(0);
await agent.disconnect();

const editor = provider(PORT, false);
await editor.connect();
const editorAgentItems = (await editor.listObjects(["Agent"], "dataitem")).length;
await editor.disconnect();
sent.splice(0);

const capture = {
  fixture: {
    image: IMAGE,
    adapter: "docker/mtconnect-init/adapter.py, one position every 10 s",
    agents: {
      [String(PORT)]: "AllowPut = false (docker/mtconnect-init/agent.cfg)",
      [String(PUT_PORT)]: "AllowPut = true",
    },
    capturedAt: new Date().toISOString().slice(0, 10),
  },
  connect: { sent: connectSent },
  reads,
  refusedBeforeSend,
  surfaces: { ...surfaces, editorAgentDeviceItemCount: editorAgentItems },
  raw: {
    allowPutFalse: {
      swagger: await swaggerOperations(PORT),
      requests: [
        await raw(PORT, "PUT", `/${LATHE}?x1722-pos=9999`, "x1722-pos"),
        await raw(PORT, "POST", `/${LATHE}?p1722-prog=CAPTURE.NC`, "p1722-prog"),
        await raw(PORT, "GET", "/cancel/id=1"),
      ],
    },
    allowPutTrue: {
      swagger: await swaggerOperations(PUT_PORT),
      requests: [
        await raw(PUT_PORT, "PUT", `/${LATHE}?x1722-pos=9999`, "x1722-pos"),
        await raw(PUT_PORT, "POST", `/${LATHE}?p1722-prog=CAPTURE.NC`, "p1722-prog"),
        await raw(PUT_PORT, "GET", "/cancel/id=1"),
      ],
    },
  },
  state: {
    nextSequenceBefore: startSequence,
    nextSequenceAfter: endSequence,
    observationsBetween: endSequence > startSequence ? await observationsSince(PORT, startSequence) : [],
  },
};

const text = `${JSON.stringify(capture, null, 2)}\n`;
// No credential (the fixture has none) and no host name: the adapter's address and the agent's container id are the
// only names the agent would write, and neither may reach the file.
if (ADAPTER.test(text)) throw new Error("the capture carries the adapter's address");
if (/password|secret|token|apikey|authorization/i.test(text))
  throw new Error("the capture carries a credential-shaped key");
if (/sender="/.test(text)) throw new Error("the capture carries the agent's host name");
writeFileSync(path.join(OUT, "boundary.json"), text);
console.log(`wrote ${path.join(OUT, "boundary.json")}`);
