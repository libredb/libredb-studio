/**
 * A fake Kubernetes API server for the access review tests: an https listener on 127.0.0.1 with the committed test
 * certificate (tests/fixtures/tls), which answers `POST /apis/authorization.k8s.io/v1/subjectaccessreviews` the way a
 * kube-apiserver does, from a list of grants, or with whatever a test scripts instead.
 *
 * It writes a token file and the test CA into a temporary directory of its own and points the review's variables at
 * them and at itself, so the code under test reads them exactly as it reads a pod's projected token and CA. Every
 * request is recorded with its method, path, bearer token and parsed body, so "nothing was sent" is measured.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTlsFixtures } from "../tls-fixtures";

/** A rule the fake answers allowed for: a user or a group, and the exact resource attributes. */
export interface ReviewGrant {
  readonly user?: string;
  readonly group?: string;
  readonly verb: string;
  readonly apiGroup: string;
  readonly resource: string;
  readonly namespace: string;
  readonly name: string;
}

export interface SeenReview {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: ReviewBody;
}

export interface ReviewBody {
  readonly apiVersion?: unknown;
  readonly kind?: unknown;
  readonly spec?: {
    readonly user?: unknown;
    readonly groups?: unknown;
    readonly resourceAttributes?: Record<string, unknown>;
  };
}

/** A scripted status and body. */
export interface ScriptedAnswer {
  readonly status: number;
  readonly body: string;
}

/**
 * What the next requests get: an answer from the grants, a scripted status and body, no answer at all, or a choice
 * between a scripted answer and the grants made per review.
 */
export type FakeAnswer = "grants" | "hang" | ScriptedAnswer | ((body: ReviewBody) => ScriptedAnswer | "grants");

export const REVIEW_PATH = "/apis/authorization.k8s.io/v1/subjectaccessreviews";
/** Clearly not a credential: gitleaks scans every commit. */
export const FAKE_TOKEN = "not-a-real-token-1";

const VARIABLES = [
  "KUBERNETES_ACCESS_REVIEW_API_URL",
  "KUBERNETES_ACCESS_REVIEW_TOKEN_PATH",
  "KUBERNETES_ACCESS_REVIEW_CA_PATH",
] as const;

export class FakeKubernetesApi {
  grants: ReviewGrant[] = [];
  answer: FakeAnswer = "grants";
  /** Milliseconds to wait before answering from the grants or the script. */
  delayMs = 0;
  /** Reviews received and not answered yet, and the most there were at once since the last reset. */
  open = 0;
  maxOpen = 0;
  readonly seen: SeenReview[] = [];
  private readonly saved = new Map<string, string | undefined>();

  constructor(
    private readonly server: Server,
    readonly url: string,
    readonly directory: string,
    private readonly ca: string,
  ) {}

  get tokenPath(): string {
    return join(this.directory, "token");
  }

  get caPath(): string {
    return join(this.directory, "ca.crt");
  }

  /** Writes the token file the review reads on its next request. */
  setToken(token: string): void {
    writeFileSync(this.tokenPath, token);
  }

  /** Points the review's variables at this server, its token file and the test CA, keeping the previous values. */
  useEnv(): void {
    const values = { API_URL: this.url, TOKEN_PATH: this.tokenPath, CA_PATH: this.caPath };
    for (const name of VARIABLES) {
      if (!this.saved.has(name)) this.saved.set(name, process.env[name]);
      process.env[name] = values[name.replace("KUBERNETES_ACCESS_REVIEW_", "") as keyof typeof values];
    }
  }

  /** Puts the variables back as they were before useEnv(). */
  restoreEnv(): void {
    for (const [name, value] of this.saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    this.saved.clear();
  }

  reset(): void {
    this.grants = [];
    this.answer = "grants";
    this.delayMs = 0;
    this.open = 0;
    this.maxOpen = 0;
    this.seen.length = 0;
    this.setToken(FAKE_TOKEN);
    writeFileSync(this.caPath, this.ca);
  }

  async close(): Promise<void> {
    this.restoreEnv();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.directory, { recursive: true, force: true });
  }

  /** The answer of the grants, as a kube-apiserver writes it: the review echoed, with its status. */
  answerFromGrants(body: ReviewBody): string {
    const spec = body.spec ?? {};
    const attributes = spec.resourceAttributes ?? {};
    const groups = Array.isArray(spec.groups) ? spec.groups : [];
    const allowed = this.grants.some(
      (grant) =>
        (grant.user === undefined || grant.user === spec.user) &&
        (grant.group === undefined || groups.includes(grant.group)) &&
        (grant.user !== undefined || grant.group !== undefined) &&
        grant.verb === attributes.verb &&
        grant.apiGroup === attributes.group &&
        grant.resource === attributes.resource &&
        grant.namespace === attributes.namespace &&
        grant.name === attributes.name,
    );
    return JSON.stringify({
      kind: "SubjectAccessReview",
      apiVersion: "authorization.k8s.io/v1",
      metadata: { creationTimestamp: null },
      spec,
      status: allowed ? { allowed: true, reason: "RBAC: allowed by a test grant" } : { allowed: false },
    });
  }
}

/** Starts a fake API server on a port the system picks. */
export async function startFakeKubernetesApi(): Promise<FakeKubernetesApi> {
  const tls = loadTlsFixtures();
  const directory = mkdtempSync(join(tmpdir(), "libredb-access-review-"));
  writeFileSync(join(directory, "ca.crt"), tls.ca);
  writeFileSync(join(directory, "token"), FAKE_TOKEN);
  let api: FakeKubernetesApi | null = null;
  const server = createServer({ cert: tls.server.cert, key: tls.server.key }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const fake = api as FakeKubernetesApi;
      const text = Buffer.concat(chunks).toString("utf8");
      let body: ReviewBody = {};
      try {
        body = JSON.parse(text) as ReviewBody;
      } catch {
        // A body that is not JSON is recorded as empty; no case sends one.
      }
      fake.seen.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body,
      });
      const answer = typeof fake.answer === "function" ? fake.answer(body) : fake.answer;
      if (answer === "hang") return;
      fake.open += 1;
      fake.maxOpen = Math.max(fake.maxOpen, fake.open);
      const reply = () => {
        fake.open -= 1;
        if (answer === "grants") {
          response.writeHead(201, { "content-type": "application/json" });
          response.end(fake.answerFromGrants(body));
          return;
        }
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(answer.body);
      };
      if (fake.delayMs > 0) setTimeout(reply, fake.delayMs);
      else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  api = new FakeKubernetesApi(server, `https://127.0.0.1:${port}`, directory, tls.ca);
  return api;
}
