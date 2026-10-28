/**
 * A fake Kubernetes API server for the Kubernetes discovery exporter's tests: an https listener on 127.0.0.1 with the
 * committed test certificate (tests/fixtures/tls), which answers the three things the exporter asks the way a
 * kube-apiserver does: a paged list of a contract kind in a namespace, a get of a Secret, and a get and a put of the
 * export Secret with optimistic concurrency on its resourceVersion.
 *
 * It holds its objects in memory, and a test can script any path's answer instead. It writes a token file and the test
 * CA into a temporary directory, so the exporter reads them as it reads a pod's projected token and CA. Every request
 * is recorded with its method, path, bearer token and body, so what was asked, and what was not, is measured.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTlsFixtures } from "../tls-fixtures";

/** Clearly not a credential: gitleaks scans every commit. */
export const FAKE_DISCOVERY_TOKEN = "not-a-real-token-discovery";

export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** A scripted status and body, or no answer at all. */
export type ScriptedAnswer = { readonly status: number; readonly body: string } | "hang";

interface StoredSecret {
  metadata: Record<string, unknown> & { namespace: string; name: string; resourceVersion: string };
  type?: string;
  data?: Record<string, string>;
}

const CLUSTERS = /^\/apis\/postgresql\.cnpg\.io\/v1\/namespaces\/([^/]+)\/clusters$/;
const SECRET = /^\/api\/v1\/namespaces\/([^/]+)\/secrets\/([^/]+)$/;

/** A Kubernetes Status body, as the API server answers a refusal. */
export function statusBody(code: number, reason: string, message: string): string {
  return JSON.stringify({ kind: "Status", apiVersion: "v1", status: "Failure", message, reason, code });
}

export class FakeDiscoveryApi {
  /** CloudNativePG Clusters per namespace, in list order. */
  readonly clusters = new Map<string, Record<string, unknown>[]>();
  /** Secrets by `<namespace>/<name>`. */
  readonly secrets = new Map<string, StoredSecret>();
  /** Answers by path (without the query), taken before any stored object. */
  readonly scripted = new Map<string, ScriptedAnswer | ScriptedAnswer[]>();
  /** Namespaces whose Cluster list answers 403, and the CRD's absence, which answers 404 for every list. */
  readonly forbiddenNamespaces = new Set<string>();
  crdMissing = false;
  /** How many items one list page holds at most, whatever the request's limit says, when smaller. */
  pageSize = Number.POSITIVE_INFINITY;
  /** Bumps the export Secret's resourceVersion once before the next put, as another writer would. */
  conflictsBeforePut = 0;
  readonly seen: SeenRequest[] = [];
  private version = 100;

  constructor(
    private readonly server: Server,
    readonly url: string,
    readonly directory: string,
    readonly ca: string,
    readonly otherCa: string,
  ) {}

  get tokenPath(): string {
    return join(this.directory, "token");
  }

  get caPath(): string {
    return join(this.directory, "ca.crt");
  }

  setToken(token: string): void {
    writeFileSync(this.tokenPath, token);
  }

  setCa(ca: string): void {
    writeFileSync(this.caPath, ca);
  }

  /** The environment that points the exporter at this server, its token file and the test CA. */
  env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      KUBERNETES_DISCOVERY_API_URL: this.url,
      KUBERNETES_DISCOVERY_TOKEN_PATH: this.tokenPath,
      KUBERNETES_DISCOVERY_CA_PATH: this.caPath,
      KUBERNETES_DISCOVERY_NAMESPACES: "team-a,team-b",
      KUBERNETES_DISCOVERY_EXPORT_SECRET: "libredb-studio/libredb-studio-discovery-export",
      KUBERNETES_DISCOVERY_ONCE: "1",
      ...extra,
    };
  }

  reset(): void {
    this.clusters.clear();
    this.secrets.clear();
    this.scripted.clear();
    this.forbiddenNamespaces.clear();
    this.crdMissing = false;
    this.pageSize = Number.POSITIVE_INFINITY;
    this.conflictsBeforePut = 0;
    this.seen.length = 0;
    this.setToken(FAKE_DISCOVERY_TOKEN);
    this.setCa(this.ca);
    this.addSecret("libredb-studio", "libredb-studio-discovery-export", {}, "Opaque", {
      labels: { "app.kubernetes.io/managed-by": "Helm" },
      annotations: { "meta.helm.sh/release-name": "libredb-studio" },
    });
  }

  addCluster(namespace: string, name: string, spec: Record<string, unknown> = {}): void {
    const list = this.clusters.get(namespace) ?? [];
    list.push({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: { namespace, name, uid: `uid-${namespace}-${name}`, labels: { team: namespace } },
      spec: { instances: 1, ...spec },
      status: { phase: "Cluster in healthy state" },
    });
    this.clusters.set(namespace, list);
  }

  /**
   * Stores the `<cluster>-app` Secret as CloudNativePG writes it: owned by the Cluster, by its UID, and labelled with
   * its name. Either tie alone is what the exporter needs; `ties` drops one or both.
   */
  addAppSecret(
    namespace: string,
    cluster: string,
    data: Record<string, string | Buffer>,
    ties: { owner?: boolean; label?: boolean } = {},
  ): void {
    const { owner = true, label = true } = ties;
    this.addSecret(namespace, `${cluster}-app`, data, "kubernetes.io/basic-auth", {
      ...(label ? { labels: { "cnpg.io/cluster": cluster } } : {}),
      ...(owner
        ? {
            ownerReferences: [
              {
                apiVersion: "postgresql.cnpg.io/v1",
                kind: "Cluster",
                name: cluster,
                uid: `uid-${namespace}-${cluster}`,
                controller: true,
              },
            ],
          }
        : {}),
    });
  }

  /** Stores a Secret with `data` given as text, encoded as the API server returns it. */
  addSecret(
    namespace: string,
    name: string,
    data: Record<string, string | Buffer>,
    type = "kubernetes.io/basic-auth",
    metadata: Record<string, unknown> = {},
  ): void {
    this.version += 1;
    this.secrets.set(`${namespace}/${name}`, {
      metadata: { ...metadata, namespace, name, resourceVersion: String(this.version), managedFields: [{ x: 1 }] },
      type,
      data: Object.fromEntries(
        Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString("base64")]),
      ),
    });
  }

  /** The export Secret as stored, or undefined. */
  exportSecret(): StoredSecret | undefined {
    return this.secrets.get("libredb-studio/libredb-studio-discovery-export");
  }

  /** The export the exporter last wrote, parsed. */
  writtenExport(): Record<string, unknown> | undefined {
    const encoded = this.exportSecret()?.data?.["export.json"];
    return encoded === undefined ? undefined : JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.directory, { recursive: true, force: true });
  }

  /** What the fake answers a request: a scripted answer, or one from the stored objects. */
  answer(method: string, url: URL, body: unknown): ScriptedAnswer {
    const scripted = this.scripted.get(url.pathname);
    if (scripted !== undefined) {
      if (!Array.isArray(scripted)) return scripted;
      const next = scripted.shift();
      if (scripted.length === 0) this.scripted.delete(url.pathname);
      if (next !== undefined) return next;
    }
    const clusters = CLUSTERS.exec(url.pathname);
    if (clusters !== null && method === "GET") return this.list(clusters[1], url);
    const secret = SECRET.exec(url.pathname);
    if (secret !== null) return this.secret(method, `${secret[1]}/${secret[2]}`, body);
    return { status: 404, body: statusBody(404, "NotFound", "the server could not find the requested resource") };
  }

  private list(namespace: string, url: URL): ScriptedAnswer {
    if (this.crdMissing) {
      return { status: 404, body: statusBody(404, "NotFound", "the server could not find the requested resource") };
    }
    if (this.forbiddenNamespaces.has(namespace)) {
      return {
        status: 403,
        body: statusBody(
          403,
          "Forbidden",
          `clusters.postgresql.cnpg.io is forbidden: User "system:serviceaccount:libredb-studio:discovery" cannot list resource "clusters" in API group "postgresql.cnpg.io" in the namespace "${namespace}"`,
        ),
      };
    }
    const all = this.clusters.get(namespace) ?? [];
    const limit = Math.min(Number(url.searchParams.get("limit") ?? all.length) || all.length, this.pageSize);
    const start = Number(url.searchParams.get("continue") ?? "0");
    const items = all.slice(start, start + limit);
    const next = start + limit < all.length ? String(start + limit) : "";
    return {
      status: 200,
      body: JSON.stringify({
        apiVersion: "postgresql.cnpg.io/v1",
        kind: "ClusterList",
        metadata: { resourceVersion: "1", ...(next === "" ? {} : { continue: next }) },
        items,
      }),
    };
  }

  private secret(method: string, key: string, body: unknown): ScriptedAnswer {
    const stored = this.secrets.get(key);
    const [namespace, name] = key.split("/");
    if (stored === undefined) {
      return { status: 404, body: statusBody(404, "NotFound", `secrets "${name}" not found`) };
    }
    if (method === "GET") {
      return { status: 200, body: JSON.stringify({ kind: "Secret", apiVersion: "v1", ...stored }) };
    }
    if (method === "PUT") {
      if (this.conflictsBeforePut > 0) {
        this.conflictsBeforePut -= 1;
        this.version += 1;
        stored.metadata.resourceVersion = String(this.version);
      }
      const sent = body as StoredSecret;
      if (sent?.metadata?.resourceVersion !== stored.metadata.resourceVersion) {
        return {
          status: 409,
          body: statusBody(
            409,
            "Conflict",
            `Operation cannot be fulfilled on secrets "${name}": the object has been modified; please apply your changes to the latest version and try again`,
          ),
        };
      }
      this.version += 1;
      const next: StoredSecret = {
        metadata: { ...sent.metadata, namespace, name, resourceVersion: String(this.version) },
        type: sent.type,
        data: sent.data,
      };
      this.secrets.set(key, next);
      return { status: 200, body: JSON.stringify({ kind: "Secret", apiVersion: "v1", ...next }) };
    }
    return { status: 405, body: statusBody(405, "MethodNotAllowed", "method not allowed") };
  }
}

/** Starts a fake API server on a port the system picks. */
export async function startFakeDiscoveryApi(): Promise<FakeDiscoveryApi> {
  const tls = loadTlsFixtures();
  const directory = mkdtempSync(join(tmpdir(), "libredb-kubernetes-discovery-api-"));
  let api: FakeDiscoveryApi | null = null;
  const server = createServer({ cert: tls.server.cert, key: tls.server.key }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const fake = api as FakeDiscoveryApi;
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        body = text;
      }
      const url = new URL(request.url ?? "/", "https://fake.invalid");
      fake.seen.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body,
      });
      const answer = fake.answer(request.method ?? "", url, body);
      if (answer === "hang") return;
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  api = new FakeDiscoveryApi(server, `https://127.0.0.1:${port}`, directory, tls.ca, tls.otherCa);
  api.reset();
  return api;
}
