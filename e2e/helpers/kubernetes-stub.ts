/**
 * A stub Kubernetes API server for e2e/kubernetes-provider.spec.ts: https on a loopback port the system picks, with the
 * throwaway certificate of tests/fixtures/tls/ (for localhost, 127.0.0.1 and ::1), answering every request from the
 * v1.35.5 captures of tests/fixtures/kubernetes/ through the replay the integration test uses. The bearer token picks
 * the persona's capture; a request nobody recorded answers a `text/plain` 404 and is kept in `unrecorded`, so the
 * spec can say which read the capture plan still lacks.
 */
import { createPrivateKey, type webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { readCapture, replayAnswer, requestKey, UNRECORDED_ANSWER } from "../../tests/helpers/kubernetes-replay";

/** The tokens the end-to-end test signs in with, each the key of one persona's capture. */
export const STUB_TOKENS = Object.freeze({ reader: "e2e-reader-token", viewer: "e2e-viewer-token" });

export interface KubernetesStub {
  readonly port: number;
  /** The CA that signed the stub's certificate, PEM. */
  readonly caPem: string;
  readonly unrecorded: string[];
  close(): Promise<void>;
}

const ROOT = process.cwd();

function tlsFile(name: string): string {
  return readFileSync(path.join(ROOT, "tests/fixtures/tls", name), "utf8");
}

export async function startKubernetesStub(): Promise<KubernetesStub> {
  const jwk = JSON.parse(tlsFile("server.key.jwk.json")) as webcrypto.JsonWebKey;
  const key = createPrivateKey({ key: jwk, format: "jwk" }).export({ type: "pkcs8", format: "pem" }).toString();
  const answers: Record<string, ReturnType<typeof replayAnswer>> = {
    [STUB_TOKENS.reader]: replayAnswer(
      readCapture(path.join(ROOT, "tests/fixtures/kubernetes/v1.35.5/reader.json")).exchanges,
    ),
    [STUB_TOKENS.viewer]: replayAnswer(
      readCapture(path.join(ROOT, "tests/fixtures/kubernetes/v1.35.5/viewer.json")).exchanges,
    ),
  };
  const unrecorded: string[] = [];
  const server: Server = createServer({ cert: tlsFile("server.crt"), key }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks).toString("utf8");
      const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      const answer = Object.hasOwn(answers, token) ? answers[token] : undefined;
      if (answer === undefined) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ kind: "Status", status: "Failure", reason: "Unauthorized", code: 401 }));
        return;
      }
      const method = request.method ?? "GET";
      const url = request.url ?? "/";
      const replayed = answer(method, url, body);
      if (replayed === UNRECORDED_ANSWER) unrecorded.push(requestKey(method, url, body));
      response.writeHead(replayed.status, {
        "content-type": replayed.contentType ?? "application/json",
        ...(replayed.retryAfter === null ? {} : { "retry-after": replayed.retryAfter }),
      });
      response.end(replayed.text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    caPem: tlsFile("ca.crt"),
    unrecorded,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
