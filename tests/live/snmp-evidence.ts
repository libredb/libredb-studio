/**
 * Records what the pinned SNMP fixture answers, so the integration layer can replay it with no
 * Docker and no socket to the outside.
 *
 * HOW IT RECORDS. A UDP relay sits between the provider and the agent: the provider is pointed at
 * the relay, the relay forwards to the fixture and writes down both datagrams. Nothing is injected
 * into the provider, so what is recorded is exactly what the provider sent and exactly what the
 * agent answered - not what a seam thought it would send.
 *
 * REGENERATE THE RECORDINGS WITH:
 *
 *   docker compose -f database-compose.yml --profile snmp up -d snmp
 *   bun tests/live/snmp-evidence.ts 127.0.0.1:1161
 *   node --experimental-strip-types tests/live/snmp-evidence.ts 127.0.0.1:1161
 *
 * The file it writes names the image digest, the package version and the date, because a recording
 * whose source cannot be named is a recording nobody can refresh.
 *
 * Excluded from `bun run test` like everything in tests/live/: it needs the fixture.
 */
import { createSocket } from "node:dgram";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SnmpProvider } from "@/lib/db/providers/network/snmp/index";
import type { DatabaseConnection } from "@/lib/types";
import { FIXTURE_COMMUNITY } from "../fixtures/snmp/identity";
import { keyOf, readRequest } from "../helpers/snmp-capture";

const STATEMENTS = [
  "get 1.3.6.1.2.1.1.5.0",
  "get sysName.0",
  "get 1.3.6.1.4.1.8072.9999.9999.4.0",
  "next 1.3.6.1.4.1.8072.9999.9999",
  "walk 1.3.6.1.4.1.8072.9999.9999",
  "walk system",
  "table 1.3.6.1.4.1.8072.9999.9999.10.1",
  "get 1.3.6.1.4.1.8072.9999.9999.404.0",
];

async function relay(
  target: { host: string; port: number },
  book: Map<string, string>,
  sockets: { close: () => void }[],
): Promise<number> {
  const front = createSocket("udp4");
  const back = createSocket("udp4");
  let caller: { port: number; address: string } | undefined;
  let pending: string | undefined;
  front.on("message", (datagram, from) => {
    caller = { port: from.port, address: from.address };
    pending = keyOf(readRequest(Uint8Array.from(datagram)));
    back.send(datagram, target.port, target.host);
  });
  back.on("message", (datagram) => {
    if (pending !== undefined && caller !== undefined) {
      book.set(pending, Buffer.from(datagram).toString("base64"));
      front.send(datagram, caller.port, caller.address);
    }
  });
  await new Promise<void>((resolve) => front.bind(0, "127.0.0.1", () => resolve()));
  await new Promise<void>((resolve) => back.bind(0, "127.0.0.1", () => resolve()));
  sockets.push(front, back);
  return (front.address() as { port: number }).port;
}

const [host, port] = (process.argv[2] ?? "127.0.0.1:1161").split(":");
const book = new Map<string, string>();
const sockets: { close: () => void }[] = [];
const relayPort = await relay({ host, port: Number(port) }, book, sockets);
const connection = {
  id: "evidence",
  name: "snmp evidence",
  type: "snmp",
  host: "127.0.0.1",
  port: relayPort,
  password: FIXTURE_COMMUNITY,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as unknown as DatabaseConnection;

const provider = new SnmpProvider(connection, {});
await provider.connect();
const notes: string[] = [];
for (const statement of STATEMENTS) {
  try {
    const result = (await provider.query(statement)) as { rowCount?: number };
    notes.push(`${statement} -> ${result.rowCount ?? 0} rows`);
  } catch (error) {
    notes.push(`${statement} -> refused: ${(error as Error).message.slice(0, 80)}`);
  }
}
// The health read is its own Get of two objects, which no statement above sends.
const health = await provider.getHealth();
notes.push(`getHealth -> uptime ${health.uptime}, ${health.roundTripMs} ms`);
await provider.disconnect();

const out = {
  recordedAt: new Date().toISOString().slice(0, 10),
  agent:
    "libredb-fixture/snmp:5.9.4, built from docker/snmp (debian:trixie-slim digest a29215f6, snmpd 5.9.4+dfsg-2+deb13u1)",
  community: FIXTURE_COMMUNITY,
  regenerate:
    "docker compose -f database-compose.yml --profile snmp up -d snmp && bun tests/live/snmp-evidence.ts 127.0.0.1:1161",
  statements: notes,
  exchanges: [...book.entries()].map(([key, answer]) => ({ key, answer })),
};
const path = join(import.meta.dirname ?? ".", "..", "fixtures", "snmp", "captures", "agent.json");
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(`${book.size} exchanges recorded into ${path}`);
for (const note of notes) console.log(`  ${note}`);
// The relay's two sockets hold the event loop open: without this the script finishes its work and
// then sits there, which looked like a hang the first time it ran.
for (const socket of sockets) socket.close();
