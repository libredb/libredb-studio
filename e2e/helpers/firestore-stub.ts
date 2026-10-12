/**
 * A stub Firestore emulator for e2e/firestore-provider.spec.ts: plain HTTP on a fixed loopback port, the port the
 * Firestore server's FIRESTORE_EMULATOR_HOST names, answering every request from the browse and console captures of
 * tests/fixtures/firestore/1.22.0/ through the replay the integration test uses. A request nobody recorded answers a
 * `text/plain` 404 and is kept in `unrecorded`, so the spec can say which read the capture plan still lacks; a request
 * without the literal `Bearer owner` is kept in `unauthorized`; every request is kept in `requests`.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import {
  type FirestoreCapture,
  replayAnswer,
  replayKey,
  UNRECORDED_ANSWER,
} from "../../tests/helpers/firestore-replay";

export const FIRESTORE_STUB_PORT = Number(process.env.E2E_FIRESTORE_STUB_PORT ?? 3014);
const CAPTURES = path.join(process.cwd(), "tests/fixtures/firestore/1.22.0");

export interface FirestoreStub {
  readonly port: number;
  readonly requests: string[];
  readonly unrecorded: string[];
  readonly unauthorized: string[];
  close(): Promise<void>;
}

export async function startFirestoreStub(port = FIRESTORE_STUB_PORT): Promise<FirestoreStub> {
  const exchanges = ["browse", "console"].flatMap(
    (scenario) =>
      (JSON.parse(readFileSync(path.join(CAPTURES, `${scenario}.json`), "utf8")) as FirestoreCapture).exchanges,
  );
  const answer = replayAnswer(exchanges);
  const requests: string[] = [];
  const unrecorded: string[] = [];
  const unauthorized: string[] = [];
  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const method = incoming.method === "POST" ? "POST" : "GET";
      const pathAndQuery = incoming.url ?? "/";
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks).toString("utf8");
      requests.push(`${method} ${pathAndQuery}`);
      if (incoming.method !== "GET" && incoming.method !== "POST")
        unrecorded.push(`${incoming.method} ${pathAndQuery}`);
      if (incoming.headers.authorization !== "Bearer owner") unauthorized.push(`${method} ${pathAndQuery}`);
      const request = { method, path: pathAndQuery, ...(body === undefined ? {} : { body }) } as const;
      const replayed = answer("emulator", request);
      if (replayed === UNRECORDED_ANSWER) unrecorded.push(replayKey("emulator", request));
      outgoing.writeHead(replayed.status, {
        "content-type": replayed.contentType ?? "application/json",
        ...(replayed.retryAfter === null ? {} : { "retry-after": replayed.retryAfter }),
      });
      outgoing.end(replayed.text);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    port,
    requests,
    unrecorded,
    unauthorized,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
