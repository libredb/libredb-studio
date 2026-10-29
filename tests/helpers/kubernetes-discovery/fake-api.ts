/**
 * A fake Kubernetes API server for the Kubernetes discovery exporter's tests: an https listener on 127.0.0.1 with the
 * committed test certificate (tests/fixtures/tls), which answers the four things the exporter asks the way a
 * kube-apiserver does: a paged list of a contract kind in a namespace, a get of a Service, a get of a Secret, and a get
 * and a put of the export Secret with optimistic concurrency on its resourceVersion.
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
import { KUBERNETES_CONTRACT } from "@/lib/seed/kubernetes-discovery-contract";
import { type GoldenCase, goldenRow } from "../kubernetes-discovery-fixture";
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

interface StoredService {
  metadata: Record<string, unknown> & { namespace: string; name: string };
  spec: Record<string, unknown>;
}

/** How a Service is stored: its type, its selector (none when null or absent) and its ownerReferences. */
export interface ServiceShape {
  readonly type?: string;
  readonly selector?: Record<string, string> | null;
  readonly owners?: readonly Record<string, unknown>[];
}

const LIST = /^\/apis\/([^/]+)\/([^/]+)\/namespaces\/([^/]+)\/([^/]+)$/;
const SECRET = /^\/api\/v1\/namespaces\/([^/]+)\/secrets\/([^/]+)$/;
const SERVICE = /^\/api\/v1\/namespaces\/([^/]+)\/services\/([^/]+)$/;

/** A Kubernetes Status body, as the API server answers a refusal. */
export function statusBody(code: number, reason: string, message: string): string {
  return JSON.stringify({ kind: "Status", apiVersion: "v1", status: "Failure", message, reason, code });
}

/** An ownerReference to `resource`, as an operator writes one on what it controls. */
export function ownerReference(
  resource: { apiVersion: string; kind: string; metadata: { name: string; uid: string } },
  controller = true,
): Record<string, unknown> {
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    name: resource.metadata.name,
    uid: resource.metadata.uid,
    controller,
  };
}

export class FakeDiscoveryApi {
  /** Each contract kind's resources per namespace, in list order, by slug. */
  readonly resources = new Map<string, Map<string, Record<string, unknown>[]>>();
  /** Secrets by `<namespace>/<name>`. */
  readonly secrets = new Map<string, StoredSecret>();
  /** Services by `<namespace>/<name>`. */
  readonly services = new Map<string, StoredService>();
  /** Answers by path (without the query), taken before any stored object. */
  readonly scripted = new Map<string, ScriptedAnswer | ScriptedAnswer[]>();
  /** Namespaces whose lists answer 403, and the CRDs' absence, which answers 404 for every list. */
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

  /** CloudNativePG Clusters per namespace, in list order. */
  get clusters(): Map<string, Record<string, unknown>[]> {
    return this.kindResources("cnpg");
  }

  /** The resources of the kind `slug` per namespace. */
  kindResources(slug: string): Map<string, Record<string, unknown>[]> {
    let byNamespace = this.resources.get(slug);
    if (byNamespace === undefined) {
      byNamespace = new Map();
      this.resources.set(slug, byNamespace);
    }
    return byNamespace;
  }

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
    this.resources.clear();
    this.secrets.clear();
    this.services.clear();
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

  /**
   * Stores a CloudNativePG Cluster and its read-write Service as the operator writes it: a ClusterIP Service with a
   * selector, controlled by the Cluster. `service: false` leaves the Service out.
   */
  addCluster(
    namespace: string,
    name: string,
    spec: Record<string, unknown> = {},
    options: { service?: boolean } = {},
  ): void {
    const resource = this.addResource("cnpg", namespace, name, { instances: 1, ...spec });
    if (options.service === false) return;
    this.addService(namespace, `${name}-rw`, {
      selector: { "cnpg.io/cluster": name, "cnpg.io/instanceRole": "primary" },
      owners: [ownerReference(resource)],
    });
  }

  /**
   * Stores a resource of the contract kind `slug`, once: a second call for the same namespace and name returns the one
   * already stored.
   */
  addResource(
    slug: string,
    namespace: string,
    name: string,
    spec: Record<string, unknown> = {},
    uid = `uid-${namespace}-${name}`,
  ): { apiVersion: string; kind: string; metadata: { namespace: string; name: string; uid: string } } {
    const row = KUBERNETES_CONTRACT.find((candidate) => candidate.slug === slug);
    if (row === undefined) throw new Error(`no contract row has the slug ${slug}`);
    const byNamespace = this.kindResources(slug);
    const list = byNamespace.get(namespace) ?? [];
    const found = list.find((item) => (item.metadata as { name?: string } | undefined)?.name === name);
    if (found !== undefined) return found as ReturnType<FakeDiscoveryApi["addResource"]>;
    const resource = {
      apiVersion: `${row.group}/${row.version}`,
      kind: row.kind,
      metadata: { namespace, name, uid, labels: { team: namespace } },
      spec,
      status: { phase: "healthy" },
    };
    list.push(resource);
    byNamespace.set(namespace, list);
    return resource;
  }

  /** Stores a Service; a selector of null or {} is none, as on a selector-less Service. */
  addService(namespace: string, name: string, shape: ServiceShape = {}): void {
    const { type = "ClusterIP", selector = null, owners = [] } = shape;
    this.version += 1;
    this.services.set(`${namespace}/${name}`, {
      metadata: {
        namespace,
        name,
        resourceVersion: String(this.version),
        ...(owners.length === 0 ? {} : { ownerReferences: owners.map((owner) => ({ ...owner })) }),
      },
      spec: {
        type,
        ...(type === "ExternalName" ? { externalName: "db.example.com" } : { clusterIP: "None" }),
        ...(selector === null ? {} : { selector }),
      },
    });
  }

  /**
   * Stores a golden case as its operator would: the resource, its Service and its credential Secret, the Secret tied to
   * the resource unless it is a CloudNativePG or EDB initdb Secret the user supplied.
   */
  addGoldenCase(c: GoldenCase): void {
    const row = goldenRow(c);
    const { namespace, name, uid } = c.resource.metadata;
    const resource = this.addResource(row.slug, namespace, name, c.resource.spec, uid);
    this.addService(namespace, c.service.name, {
      type: c.service.type,
      selector: c.service.selector,
      owners: c.service.controller ? [ownerReference(resource)] : [],
    });
    const labels: Record<string, string> = { cnpg: "cnpg.io/cluster", edbpg: "k8s.enterprisedb.io/cluster" };
    const label = labels[row.slug];
    // An initdb Secret the user supplied is tied to nothing; every Secret an operator writes is owned by its resource.
    const supplied = label !== undefined && c.secretName !== `${name}-app`;
    this.addSecret(
      namespace,
      c.secretName,
      c.secretData,
      c.secretType,
      supplied
        ? {}
        : {
            ...(label === undefined ? {} : { labels: { [label]: name } }),
            ownerReferences: [ownerReference(resource)],
          },
    );
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
    const list = LIST.exec(url.pathname);
    if (list !== null && method === "GET") return this.list(list[1], list[2], list[3], list[4], url);
    const service = SERVICE.exec(url.pathname);
    if (service !== null && method === "GET") return this.service(`${service[1]}/${service[2]}`);
    const secret = SECRET.exec(url.pathname);
    if (secret !== null) return this.secret(method, `${secret[1]}/${secret[2]}`, body);
    return { status: 404, body: statusBody(404, "NotFound", "the server could not find the requested resource") };
  }

  private list(group: string, version: string, namespace: string, plural: string, url: URL): ScriptedAnswer {
    const row = KUBERNETES_CONTRACT.find(
      (candidate) => candidate.group === group && candidate.version === version && candidate.plural === plural,
    );
    if (this.crdMissing || row === undefined) {
      return { status: 404, body: statusBody(404, "NotFound", "the server could not find the requested resource") };
    }
    if (this.forbiddenNamespaces.has(namespace)) {
      return {
        status: 403,
        body: statusBody(
          403,
          "Forbidden",
          `${plural}.${group} is forbidden: User "system:serviceaccount:libredb-studio:discovery" cannot list resource "${plural}" in API group "${group}" in the namespace "${namespace}"`,
        ),
      };
    }
    const all = this.kindResources(row.slug).get(namespace) ?? [];
    const limit = Math.min(Number(url.searchParams.get("limit") ?? all.length) || all.length, this.pageSize);
    const start = Number(url.searchParams.get("continue") ?? "0");
    const items = all.slice(start, start + limit);
    const next = start + limit < all.length ? String(start + limit) : "";
    return {
      status: 200,
      body: JSON.stringify({
        apiVersion: `${group}/${version}`,
        kind: `${row.kind}List`,
        metadata: { resourceVersion: "1", ...(next === "" ? {} : { continue: next }) },
        items,
      }),
    };
  }

  private service(key: string): ScriptedAnswer {
    const stored = this.services.get(key);
    if (stored === undefined) {
      return { status: 404, body: statusBody(404, "NotFound", `services "${key.split("/")[1]}" not found`) };
    }
    return { status: 200, body: JSON.stringify({ kind: "Service", apiVersion: "v1", ...stored }) };
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
