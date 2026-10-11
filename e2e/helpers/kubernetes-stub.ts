/**
 * A stub Kubernetes API server for e2e/kubernetes-provider.spec.ts: https on a loopback port the system picks, with the
 * throwaway certificate of tests/fixtures/tls/ (for localhost, 127.0.0.1 and ::1), answering every request from the
 * v1.35.5 captures of tests/fixtures/kubernetes/ through the replay the integration test uses. The bearer token picks
 * the persona's capture; a request nobody recorded answers a `text/plain` 404, and one whose Accept differs from the
 * recorded one a 406, and both are kept in `unrecorded`, so the spec can say which read the capture plan still lacks.
 * Every request is kept in `requests`, so a spec can say that a refused statement sent none. The shop-only capture
 * holds no `/readyz` or `/version`, which the connection's health check reads and which the built-in
 * system:public-info-viewer role answers the same for every identity, so that persona's are answered from the
 * reader's capture.
 */
import { createPrivateKey, type webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  NOT_ACCEPTABLE_ANSWER,
  readCapture,
  replayAnswer,
  requestKey,
  UNRECORDED_ANSWER,
} from "../../tests/helpers/kubernetes-replay";

/** The tokens the end-to-end test signs in with, each the key of one persona's capture. */
export const STUB_TOKENS = Object.freeze({
  reader: "e2e-reader-token",
  viewer: "e2e-viewer-token",
  shopOnly: "e2e-shop-only-token",
});

export interface KubernetesStub {
  readonly port: number;
  /** The CA that signed the stub's certificate, PEM. */
  readonly caPem: string;
  readonly unrecorded: string[];
  /** Every request the stub answered, as `METHOD path?query`, in order. */
  readonly requests: string[];
  close(): Promise<void>;
}

const ROOT = process.cwd();

/** The paths the health check reads that every identity may read alike. */
const PUBLIC_INFO_PATHS: ReadonlySet<string> = new Set(["/readyz", "/version"]);

function tlsFile(name: string): string {
  return readFileSync(path.join(ROOT, "tests/fixtures/tls", name), "utf8");
}

export async function startKubernetesStub(): Promise<KubernetesStub> {
  const jwk = JSON.parse(tlsFile("server.key.jwk.json")) as webcrypto.JsonWebKey;
  const key = createPrivateKey({ key: jwk, format: "jwk" }).export({ type: "pkcs8", format: "pem" }).toString();
  const reader = replayAnswer(readCapture(path.join(ROOT, "tests/fixtures/kubernetes/v1.35.5/reader.json")).exchanges);
  const shopOnly = replayAnswer(
    readCapture(path.join(ROOT, "tests/fixtures/kubernetes/v1.35.5/shop-only.json")).exchanges,
  );
  const answers: Record<string, ReturnType<typeof replayAnswer>> = {
    [STUB_TOKENS.reader]: reader,
    [STUB_TOKENS.viewer]: replayAnswer(
      readCapture(path.join(ROOT, "tests/fixtures/kubernetes/v1.35.5/viewer.json")).exchanges,
    ),
    [STUB_TOKENS.shopOnly]: (method, url, body, accept) =>
      PUBLIC_INFO_PATHS.has(url) ? reader(method, url, body, accept) : shopOnly(method, url, body, accept),
  };
  const unrecorded: string[] = [];
  const requests: string[] = [];
  const server: Server = createServer({ cert: tlsFile("server.crt"), key }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks).toString("utf8");
      requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
      const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      const answer = Object.hasOwn(answers, token) ? answers[token] : undefined;
      if (answer === undefined) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ kind: "Status", status: "Failure", reason: "Unauthorized", code: 401 }));
        return;
      }
      const method = request.method ?? "GET";
      const url = request.url ?? "/";
      const accept = request.headers.accept;
      const replayed = answer(method, url, body, accept);
      if (replayed === UNRECORDED_ANSWER) unrecorded.push(requestKey(method, url, body));
      if (replayed === NOT_ACCEPTABLE_ANSWER)
        unrecorded.push(`${requestKey(method, url, body)} accept: ${accept ?? "(none)"}`);
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
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
