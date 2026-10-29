/**
 * A fake OpenShift cluster for the openshift sign-in tests: two https listeners on 127.0.0.1 with the committed test
 * certificate (tests/fixtures/tls), one the API server (the OAuth metadata document and users/~) and one the OAuth
 * server (the token endpoint), so the issuer and the API origins differ as on a cluster; plus a recording proxy that
 * counts the connections it receives and closes them.
 *
 * It writes the client secret file and the test CA into a temporary directory of its own and points the openshift
 * variables at them and at itself, so the code under test reads them as it reads a pod's projected token and CA.
 * Every request is recorded with its method, path, query, headers and body, so "nothing was sent" is measured. The
 * token endpoint checks the PKCE S256 challenge, the redirect URI and the client secret the way the OAuth server does.
 * Shapes follow the cluster: the metadata keys of the API server's document, the token answer keys (`access_token`,
 * `expires_in` 31536000, `scope`, `token_type: Bearer`) and the users/~ answer with name, uid, groups and identities.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTlsFixtures } from "../tls-fixtures";

export const CLIENT_ID = "system:serviceaccount:os-lab-studio:studio";
/** Clearly not a credential: gitleaks scans every commit. */
export const CLIENT_SECRET = "client-secret-not-a-real-token";
export const PUBLIC_URL = "https://studio.apps.example.com";
export const ACCESS_TOKEN = "sha256~not-a-real-token-1";
export const METADATA_PATH = "/.well-known/oauth-authorization-server";
export const USER_PATH = "/apis/user.openshift.io/v1/users/~";
export const TOKEN_PATH = "/oauth/token";
export const AUTHORIZE_PATH = "/oauth/authorize";

export interface RecordedRequest {
  readonly server: "api" | "oauth";
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** A scripted answer: a status with an optional body and headers, no answer at all, or a body past every cap. */
export type ScriptedAnswer =
  | { readonly status: number; readonly body?: string; readonly headers?: Readonly<Record<string, string>> }
  | "hang"
  | "oversize";

/** A script for one path: an answer, or a function of the request whose `undefined` falls back to the default. */
export type Script = ScriptedAnswer | ((request: RecordedRequest) => ScriptedAnswer | undefined);

export interface FakeUser {
  name: string;
  uid: string | undefined;
  groups: string[];
}

interface IssuedCode {
  readonly challenge: string;
  readonly redirectUri: string;
  readonly clientId: string;
}

const VARIABLES = [
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "OPENSHIFT_OAUTH_CLIENT_ID",
  "OPENSHIFT_OAUTH_TOKEN_FILE",
  "OPENSHIFT_API_URL",
  "OPENSHIFT_API_CA_FILE",
  "OPENSHIFT_PUBLIC_URL",
] as const;

const json = (status: number, document: unknown): ScriptedAnswer => ({
  status,
  body: JSON.stringify(document),
  headers: { "content-type": "application/json" },
});

export class FakeCluster {
  readonly requests: RecordedRequest[] = [];
  readonly proxy = { url: "", connections: 0 };
  user: FakeUser = { name: "dev-a", uid: "0b6f5c1e-4d2a-4c55-9e1f-7a3b2c1d0e9f", groups: ["system:authenticated"] };
  /** The token endpoint's success answer; `access_token` is also what users/~ accepts as a bearer. */
  tokenAnswer: Record<string, unknown> = {};
  private readonly scripts = new Map<string, Script>();
  private readonly codes = new Map<string, IssuedCode>();
  private readonly saved = new Map<string, string | undefined>();
  private clientSecret = CLIENT_SECRET;

  constructor(
    private readonly servers: { readonly api: Server; readonly oauth: Server; readonly proxy: NetServer },
    readonly apiUrl: string,
    readonly issuerOrigin: string,
    readonly directory: string,
    private readonly ca: string,
  ) {
    this.reset();
  }

  get tokenFile(): string {
    return join(this.directory, "oauth-client-token");
  }

  get caFile(): string {
    return join(this.directory, "ca.crt");
  }

  /** Answers every later request to `path` (on either server) from `answer`, until reset(). */
  script(path: string, answer: Script): void {
    this.scripts.set(path, answer);
  }

  /** Rewrites the client secret file, as a projected token rotates. */
  setClientSecret(secret: string): void {
    this.clientSecret = secret;
    writeFileSync(this.tokenFile, secret);
  }

  /**
   * The person approves the authorize request `url` names: a code bound to its PKCE challenge, redirect URI and client
   * id is issued, and the callback parameters (`code`, `state`) come back.
   */
  authorize(url: URL): URLSearchParams {
    const query = url.searchParams;
    const code = randomBytes(16).toString("hex");
    this.codes.set(code, {
      challenge: query.get("code_challenge") ?? "",
      redirectUri: query.get("redirect_uri") ?? "",
      clientId: query.get("client_id") ?? "",
    });
    return new URLSearchParams({ code, state: query.get("state") ?? "" });
  }

  /** The requests one server received. */
  received(server: "api" | "oauth"): RecordedRequest[] {
    return this.requests.filter((request) => request.server === server);
  }

  /** The metadata document the API server serves, as the cluster's has it. */
  metadata(): Record<string, unknown> {
    return {
      issuer: this.issuerOrigin,
      authorization_endpoint: `${this.issuerOrigin}${AUTHORIZE_PATH}`,
      token_endpoint: `${this.issuerOrigin}${TOKEN_PATH}`,
      scopes_supported: [
        "user:check-access",
        "user:full",
        "user:info",
        "user:list-projects",
        "user:list-scoped-projects",
      ],
      response_types_supported: ["code", "token"],
      grant_types_supported: ["authorization_code", "implicit"],
      code_challenge_methods_supported: ["plain", "S256"],
    };
  }

  /** Points the openshift variables at this cluster, its secret file and the test CA, keeping the previous values. */
  useEnv(): void {
    const values: Record<(typeof VARIABLES)[number], string> = {
      NEXT_PUBLIC_AUTH_PROVIDER: "openshift",
      OPENSHIFT_OAUTH_CLIENT_ID: CLIENT_ID,
      OPENSHIFT_OAUTH_TOKEN_FILE: this.tokenFile,
      OPENSHIFT_API_URL: this.apiUrl,
      OPENSHIFT_API_CA_FILE: this.caFile,
      OPENSHIFT_PUBLIC_URL: PUBLIC_URL,
    };
    for (const name of VARIABLES) {
      if (!this.saved.has(name)) this.saved.set(name, process.env[name]);
      process.env[name] = values[name];
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
    this.requests.length = 0;
    this.proxy.connections = 0;
    this.scripts.clear();
    this.codes.clear();
    this.user = { name: "dev-a", uid: "0b6f5c1e-4d2a-4c55-9e1f-7a3b2c1d0e9f", groups: ["system:authenticated"] };
    this.tokenAnswer = {
      access_token: ACCESS_TOKEN,
      expires_in: 31536000,
      scope: "user:info user:check-access",
      token_type: "Bearer",
    };
    this.setClientSecret(CLIENT_SECRET);
    writeFileSync(this.caFile, this.ca);
  }

  async close(): Promise<void> {
    this.restoreEnv();
    for (const server of [this.servers.api, this.servers.oauth]) server.closeAllConnections();
    await Promise.all(
      [this.servers.api, this.servers.oauth, this.servers.proxy].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    rmSync(this.directory, { recursive: true, force: true });
  }

  /** What a request gets: its path's script first, then the default of its server. */
  answer(request: RecordedRequest): ScriptedAnswer {
    const script = this.scripts.get(request.path);
    const scripted = typeof script === "function" ? script(request) : script;
    if (scripted !== undefined) return scripted;
    if (request.server === "api" && request.path === METADATA_PATH) return json(200, this.metadata());
    if (request.server === "api" && request.path === USER_PATH) return this.userAnswer(request);
    if (request.server === "oauth" && request.path === TOKEN_PATH) return this.tokenEndpoint(request);
    return json(404, { kind: "Status", status: "Failure", reason: "NotFound", code: 404 });
  }

  private userAnswer(request: RecordedRequest): ScriptedAnswer {
    if (request.headers.authorization !== `Bearer ${String(this.tokenAnswer.access_token)}`) {
      return json(401, { kind: "Status", status: "Failure", reason: "Unauthorized", code: 401 });
    }
    return json(200, {
      kind: "User",
      apiVersion: "user.openshift.io/v1",
      metadata: { name: this.user.name, uid: this.user.uid, resourceVersion: "4321" },
      identities: [`htpasswd:${this.user.name}`],
      groups: this.user.groups,
    });
  }

  private tokenEndpoint(request: RecordedRequest): ScriptedAnswer {
    const form = new URLSearchParams(request.body);
    const issued = this.codes.get(form.get("code") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const refused =
      issued === undefined ||
      form.get("grant_type") !== "authorization_code" ||
      form.get("client_id") !== issued.clientId ||
      form.get("client_secret") !== this.clientSecret ||
      form.get("redirect_uri") !== issued.redirectUri ||
      challenge !== issued.challenge;
    if (refused) return json(400, { error: "invalid_grant" });
    this.codes.delete(form.get("code") as string);
    return json(200, this.tokenAnswer);
  }
}

function handler(server: "api" | "oauth", cluster: () => FakeCluster) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const fake = cluster();
      const url = new URL(request.url ?? "/", "https://fake.invalid");
      const recorded: RecordedRequest = {
        server,
        method: request.method ?? "",
        path: url.pathname,
        query: url.search,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      fake.requests.push(recorded);
      const answer = fake.answer(recorded);
      if (answer === "hang") return;
      if (answer === "oversize") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`"${"x".repeat(1024 * 1024)}"`);
        return;
      }
      response.writeHead(answer.status, answer.headers);
      response.end(answer.body ?? "");
    });
  };
}

async function listen(server: Server | NetServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

/** Starts the two fake servers and the recording proxy on ports the system picks, and points the variables at them. */
export async function startFakeCluster(): Promise<FakeCluster> {
  const tls = loadTlsFixtures();
  const directory = mkdtempSync(join(tmpdir(), "libredb-openshift-auth-"));
  let cluster: FakeCluster | null = null;
  const current = () => cluster as FakeCluster;
  const options = { cert: tls.server.cert, key: tls.server.key };
  const api = createServer(options, handler("api", current));
  const oauth = createServer(options, handler("oauth", current));
  const proxy = createNetServer((socket) => {
    current().proxy.connections += 1;
    socket.destroy();
  });
  const [apiPort, oauthPort, proxyPort] = await Promise.all([listen(api), listen(oauth), listen(proxy)]);
  cluster = new FakeCluster(
    { api, oauth, proxy },
    `https://127.0.0.1:${apiPort}`,
    `https://localhost:${oauthPort}`,
    directory,
    tls.ca,
  );
  cluster.proxy.url = `http://127.0.0.1:${proxyPort}`;
  cluster.useEnv();
  return cluster;
}

/** A port nothing listens on: bound once and released. */
export async function closedPort(): Promise<number> {
  const server = createNetServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
