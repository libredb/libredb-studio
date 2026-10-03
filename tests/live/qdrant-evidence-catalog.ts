/**
 * What tests/live/qdrant-evidence.ts captures, as data (vector-family spec 7.3): every capture's file name, the
 * service and credential it runs against, its request, and the status the research measured for it where one was
 * measured. Pure, so tests/unit/db/qdrant/evidence-catalog.test.ts holds the catalog without a server, and
 * tests/helpers/qdrant-fixtures.ts reads the file names from here: the harness writes exactly these.
 *
 * It imports no provider code. The 17 routes come from tests/fixtures/vector/routes/qdrant-v1.json, which
 * tests/live/vector-routes.ts derives from the OpenAPI document pinned at tag v1.19.1.
 */
import { createHmac } from "node:crypto";

export type QdrantService = "qdrant" | "qdrant-auth" | "qdrant-tls" | "qdrant-mtls";

export const QDRANT_SERVICES: Readonly<
  Record<QdrantService, { readonly port: number; readonly container: string; readonly tls: boolean }>
> = {
  qdrant: { port: 6333, container: "libredb-qdrant", tls: false },
  "qdrant-auth": { port: 6343, container: "libredb-qdrant-auth", tls: false },
  "qdrant-tls": { port: 6353, container: "libredb-qdrant-tls", tls: true },
  "qdrant-mtls": { port: 6363, container: "libredb-qdrant-mtls", tls: true },
};

/** The collections docker/qdrant/seed.py creates, sorted. */
export const SEEDED_COLLECTIONS = [
  "docs",
  "edge_values",
  "empty_novec",
  "payload_spread",
  "plain",
  "scratch",
  "small_dtypes",
] as const;

/** Every collection the harness creates starts with this, and its setup client can write nothing else. */
export const HARNESS_PREFIX = "qdrant_evidence_";
export const STRICT_COLLECTION = `${HARNESS_PREFIX}strict`;
export const RATE_COLLECTION = `${HARNESS_PREFIX}rate`;

export type CaptureGroup = "routes" | "credentials" | "aliases" | "timeouts" | "strict" | "errors" | "filters" | "tls";

export const CAPTURE_GROUPS: readonly CaptureGroup[] = [
  "routes",
  "credentials",
  "aliases",
  "timeouts",
  "strict",
  "errors",
  "filters",
  "tls",
];

/** A credential by what it is; the harness reads the keys from the copied volume and mints the JWTs. */
export type CredentialName =
  | "none"
  | "wrong-key"
  | "admin-key"
  | "read-only-key"
  | "jwt-global-read"
  | "jwt-global-manage"
  | "jwt-scoped"
  | "jwt-no-access-claim"
  | "jwt-empty-access"
  | "jwt-alias-only"
  | "jwt-collection-only"
  | "jwt-alias-and-collection"
  | "jwt-expired"
  | "jwt-bad-signature";

/** 2025-10-02T00:00:00Z: the expiry of the token that is always refused. */
const EXPIRED_AT = 1_759_363_200;

/** The claims of each JWT the harness mints, HS256 with the auth service's admin key; `exp` is added at run time. */
export const JWT_CLAIMS: Readonly<Partial<Record<CredentialName, Readonly<Record<string, unknown>>>>> = {
  "jwt-global-read": { access: "r" },
  "jwt-global-manage": { access: "m" },
  "jwt-scoped": {
    access: [
      { collection: "docs", access: "r" },
      { collection: "scratch", access: "rw" },
    ],
    sub: "evidence-scoped",
  },
  "jwt-no-access-claim": {},
  "jwt-empty-access": { access: [] },
  "jwt-alias-only": { access: [{ collection: "docs_alias", access: "r" }] },
  "jwt-collection-only": { access: [{ collection: "docs", access: "r" }] },
  "jwt-alias-and-collection": {
    access: [
      { collection: "docs_alias", access: "r" },
      { collection: "docs", access: "r" },
    ],
  },
  "jwt-expired": { access: "r", exp: EXPIRED_AT },
  "jwt-bad-signature": { access: "r" },
};

/** An HS256 JWT, as the research's make-jwt.py minted them. Never written to a file. */
export function mintJwt(claims: Readonly<Record<string, unknown>>, secret: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signed = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  return `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
}

export interface CaptureTls {
  /** The host the request names: the certificate carries both. */
  readonly host: "localhost" | "127.0.0.1";
  readonly ca: boolean;
  readonly clientCertificate: boolean;
  /** Plain HTTP sent to the TLS port. */
  readonly plaintext?: true;
}

export interface CaptureSpec {
  readonly service: QdrantService;
  /** The file under tests/fixtures/qdrant/<service>/, without .json. */
  readonly name: string;
  readonly group: CaptureGroup;
  readonly surface: string;
  /** The OpenAPI operation id; null for a request outside the 17, which only the harness's own client sends. */
  readonly op: string | null;
  readonly credential: CredentialName;
  readonly method: "GET" | "POST";
  /** Path and query. */
  readonly path: string;
  readonly body?: string;
  /** What the capture records in place of `body` when the body is a long generated filter. */
  readonly bodyNote?: string;
  /** The status the research measured; an answer with another status stops the run. */
  readonly expectStatus?: number;
  /** Sent again, up to this many times, until the status is `expectStatus`: a shape that depends on a timer race. */
  readonly attempts?: number;
  readonly tls?: CaptureTls;
  /** A capture that must fail before any HTTP answer: a refused handshake. */
  readonly expectNoAnswer?: true;
}

export interface FixtureRoute {
  readonly method: string;
  readonly path: string;
  readonly op: string;
  readonly params: Readonly<Record<string, string>>;
}

const kebab = (text: string) => text.replace(/_/g, "-");

/** The payload key each seeded collection is faceted and grouped by; only `docs` has a keyword index on its key. */
const KEY_OF: Readonly<Record<(typeof SEEDED_COLLECTIONS)[number], string>> = {
  docs: "category",
  edge_values: "label",
  empty_novec: "label",
  payload_spread: "category",
  plain: "city",
  scratch: "label",
  small_dtypes: "label",
};

function routeBody(
  op: string,
  collection: (typeof SEEDED_COLLECTIONS)[number],
  ids: readonly string[],
): string | undefined {
  const key = JSON.stringify(KEY_OF[collection]);
  switch (op) {
    case "get_points":
      return `{"ids":[${(ids.length > 0 ? ids : ["1"]).join(",")}],"with_payload":true,"with_vector":true}`;
    case "scroll_points":
      return '{"limit":3,"with_payload":true,"with_vector":true}';
    case "count_points":
      return '{"exact":true}';
    case "facet":
      return `{"key":${key},"limit":10}`;
    case "query_points":
      return '{"limit":3,"with_payload":true}';
    case "query_batch_points":
      return '{"searches":[{"limit":2},{"limit":1,"with_payload":true}]}';
    case "query_points_groups":
      return `{"group_by":${key},"limit":2,"group_size":2}`;
    default:
      return undefined;
  }
}

/**
 * The 17 routes on every seeded collection, on the open service. `ids` holds, per collection, the JSON tokens of its
 * first points' ids (a bare integer with its exact digits, or a quoted UUID), read from that collection's own scroll
 * capture, so an id above 2^53 is never written through a JS number.
 */
export function routeCaptures(
  routes: readonly FixtureRoute[],
  ids: Readonly<Record<string, readonly string[]>> = {},
): CaptureSpec[] {
  const top = routes.filter((route) => Object.keys(route.params).length === 0);
  const perCollection = routes.filter((route) => Object.keys(route.params).length > 0);
  // The scroll goes first, because the ids the two retrieve routes ask for come from its answer.
  const ordered = [...perCollection].sort(
    (a, b) => Number(b.op === "scroll_points") - Number(a.op === "scroll_points") || a.op.localeCompare(b.op),
  );
  return [
    ...top.map(
      (route): CaptureSpec => ({
        service: "qdrant",
        name: kebab(route.op),
        group: "routes",
        surface: `${route.method} ${route.path}`,
        op: route.op,
        credential: "none",
        method: route.method as "GET" | "POST",
        path: route.path,
        expectStatus: 200,
      }),
    ),
    ...SEEDED_COLLECTIONS.flatMap((collection) =>
      ordered.map((route): CaptureSpec => {
        const own = ids[collection] ?? [];
        // A quoted UUID goes into the path without its quotes; an integer as its digits.
        const first = own.length > 0 ? own[0].replace(/^"|"$/g, "") : "1";
        const path = route.path.replace("{collection_name}", collection).replace("{id}", first);
        const body = routeBody(route.op, collection, own);
        return {
          service: "qdrant",
          name: `${kebab(route.op)}-${collection}`,
          group: "routes",
          surface: `${route.method} ${route.path} on ${collection}`,
          op: route.op,
          credential: "none",
          method: route.method as "GET" | "POST",
          path,
          body,
        };
      }),
    ),
  ];
}

const AUTH_ROUTES = [
  { name: "root", op: "root", method: "GET", path: "/" },
  { name: "get-collections", op: "get_collections", method: "GET", path: "/collections" },
  { name: "get-collection-docs", op: "get_collection", method: "GET", path: "/collections/docs" },
  { name: "get-collection-plain", op: "get_collection", method: "GET", path: "/collections/plain" },
  { name: "get-collections-aliases", op: "get_collections_aliases", method: "GET", path: "/aliases" },
  {
    name: "count-points-docs",
    op: "count_points",
    method: "POST",
    path: "/collections/docs/points/count",
    body: '{"exact":true}',
  },
] as const;

/** The status each credential gets on each route of the matrix: `/` answers without a key (R30 F5, R31 5). */
const MATRIX: Readonly<Partial<Record<CredentialName, readonly number[]>>> = {
  //                      root, collections, docs, plain, aliases, count docs
  none: [200, 401, 401, 401, 401, 401],
  "wrong-key": [200, 401, 401, 401, 401, 401],
  "admin-key": [200, 200, 200, 200, 200, 200],
  "read-only-key": [200, 200, 200, 200, 200, 200],
  "jwt-global-read": [200, 200, 200, 200, 200, 200],
  "jwt-global-manage": [200, 200, 200, 200, 200, 200],
  "jwt-scoped": [200, 200, 200, 403, 200, 200],
  "jwt-no-access-claim": [200, 200, 200, 200, 200, 200],
  "jwt-empty-access": [200, 200, 403, 403, 200, 403],
  "jwt-alias-only": [200, 200, 403, 403, 200, 403],
  "jwt-expired": [200, 403, 403, 403, 403, 403],
  "jwt-bad-signature": [200, 403, 403, 403, 403, 403],
};

/** The credential matrix on `qdrant-auth` (QE4, R51 U11). */
function credentialCaptures(): CaptureSpec[] {
  return (Object.keys(MATRIX) as CredentialName[]).flatMap((credential) =>
    AUTH_ROUTES.map(
      (route, index): CaptureSpec => ({
        service: "qdrant-auth",
        name: `${credential}-${route.name}`,
        group: "credentials",
        surface: `${route.method} ${route.path} with ${credential}`,
        op: route.op,
        credential,
        method: route.method,
        path: route.path,
        body: "body" in route ? route.body : undefined,
        expectStatus: (MATRIX[credential] as readonly number[])[index],
      }),
    ),
  );
}

const ALIAS_CALLS = [
  { name: "get-collections", op: "get_collections", method: "GET", path: "/collections" },
  { name: "get-collections-aliases", op: "get_collections_aliases", method: "GET", path: "/aliases" },
  {
    name: "get-collection-aliases-docs",
    op: "get_collection_aliases",
    method: "GET",
    path: "/collections/docs/aliases",
  },
  {
    name: "get-collection-aliases-docs_alias",
    op: "get_collection_aliases",
    method: "GET",
    path: "/collections/docs_alias/aliases",
  },
  { name: "get-collection-docs_alias", op: "get_collection", method: "GET", path: "/collections/docs_alias" },
  { name: "get-collection-docs", op: "get_collection", method: "GET", path: "/collections/docs" },
  {
    name: "scroll-points-docs_alias",
    op: "scroll_points",
    method: "POST",
    path: "/collections/docs_alias/points/scroll",
    body: '{"limit":1}',
  },
  {
    name: "scroll-points-docs",
    op: "scroll_points",
    method: "POST",
    path: "/collections/docs/points/scroll",
    body: '{"limit":1}',
  },
  { name: "get-collection-plain", op: "get_collection", method: "GET", path: "/collections/plain" },
] as const;

/** R44 QM3's table: alias visibility is the intersection of grants. */
const ALIAS_MATRIX: Readonly<Partial<Record<CredentialName, readonly number[]>>> = {
  "jwt-alias-only": [200, 200, 403, 200, 200, 403, 200, 403, 403],
  "jwt-collection-only": [200, 200, 200, 403, 403, 200, 403, 200, 403],
  "jwt-alias-and-collection": [200, 200, 200, 200, 200, 200, 200, 200, 403],
};

/** QM3's alias matrix on `qdrant-auth`. */
function aliasCaptures(): CaptureSpec[] {
  return (Object.keys(ALIAS_MATRIX) as CredentialName[]).flatMap((credential) =>
    ALIAS_CALLS.map(
      (call, index): CaptureSpec => ({
        service: "qdrant-auth",
        name: `alias-matrix-${credential}-${call.name}`,
        group: "aliases",
        surface: `${call.method} ${call.path} with ${credential}`,
        op: call.op,
        credential,
        method: call.method,
        path: call.path,
        body: "body" in call ? call.body : undefined,
        expectStatus: (ALIAS_MATRIX[credential] as readonly number[])[index],
      }),
    ),
  );
}

/** A `should` filter of `count` conditions on `key` that match no point: each point is tested against all of them. */
export function slowFilter(count: number, key: string): string {
  const conditions = Array.from(
    { length: count },
    (_, index) => `{"key":${JSON.stringify(key)},"match":{"value":"no-such-value-${index}"}}`,
  );
  return `{"should":[${conditions.join(",")}]}`;
}

const SLOW_SPREAD = slowFilter(400, "sku");
const SLOW_SPREAD_NOTE = "a should filter of 400 match.value conditions on sku that match no point";
const SLOW_DOCS = slowFilter(4000, "title");
const SLOW_DOCS_NOTE = "a should filter of 4000 match.value conditions on title that match no point";
const DOCS_QUERY = `[${Array.from({ length: 384 }, () => "0.05").join(",")}]`;
const GROUPS_BODY = `{"query":${DOCS_QUERY},"using":"text","filter":${SLOW_DOCS},"group_by":"category","limit":2,"group_size":2}`;
const GROUPS_NOTE = `a 384-dimension query on docs.text, grouped by category, with ${SLOW_DOCS_NOTE}`;

/**
 * R44 QM4's recipe on the seeded collections, with `?timeout=1`: scroll, exact count and a vector query answer 500;
 * query/groups answers 408 or 500 by a timer race on the server, so each shape is asked for until it arrives.
 */
function timeoutCaptures(): CaptureSpec[] {
  const spread = (name: string, op: string, route: string, body: string, surface: string): CaptureSpec => ({
    service: "qdrant",
    name,
    group: "timeouts",
    surface: `${surface}, ?timeout=1`,
    op,
    credential: "none",
    method: "POST",
    path: `/collections/payload_spread/${route}?timeout=1`,
    body,
    bodyNote: SLOW_SPREAD_NOTE,
    expectStatus: 500,
  });
  const groups = (status: number): CaptureSpec => ({
    service: "qdrant",
    name: `timeout-groups-${status}`,
    group: "timeouts",
    surface: `points/query/groups of docs answering ${status}, ?timeout=1`,
    op: "query_points_groups",
    credential: "none",
    method: "POST",
    path: "/collections/docs/points/query/groups?timeout=1",
    body: GROUPS_BODY,
    bodyNote: GROUPS_NOTE,
    expectStatus: status,
    attempts: 24,
  });
  return [
    spread(
      "timeout-scroll",
      "scroll_points",
      "points/scroll",
      `{"filter":${SLOW_SPREAD},"limit":1,"with_payload":false}`,
      "points/scroll of payload_spread",
    ),
    spread(
      "timeout-count",
      "count_points",
      "points/count",
      `{"filter":${SLOW_SPREAD},"exact":true}`,
      "an exact points/count of payload_spread",
    ),
    spread(
      "timeout-query",
      "query_points",
      "points/query",
      `{"query":[0.1,0.2,0.3,0.4],"filter":${SLOW_SPREAD},"limit":1}`,
      "a vector points/query of payload_spread",
    ),
    groups(500),
    groups(408),
    {
      service: "qdrant",
      name: "timeout-zero",
      group: "timeouts",
      surface: "points/scroll of plain, ?timeout=0",
      op: "scroll_points",
      credential: "none",
      method: "POST",
      path: "/collections/plain/points/scroll?timeout=0",
      body: '{"limit":1}',
      expectStatus: 400,
    },
  ];
}

/** The strict-mode texts and the rate limit (R31 F7), on two collections the harness creates and removes. */
function strictCaptures(): CaptureSpec[] {
  const strict = (
    name: string,
    op: string,
    route: string,
    body: string,
    expectStatus: number,
    collection = STRICT_COLLECTION,
  ): CaptureSpec => ({
    service: "qdrant",
    name,
    group: "strict",
    surface: `${route} of ${collection}`,
    op,
    credential: "none",
    method: "POST",
    path: `/collections/${collection}/${route}`,
    body,
    expectStatus,
  });
  return [
    strict("strict-limit-exceeded", "scroll_points", "points/scroll", '{"limit":50}', 400),
    strict(
      "strict-index-required",
      "scroll_points",
      "points/scroll",
      '{"limit":2,"filter":{"must":[{"key":"label","match":{"value":"x"}}]}}',
      400,
    ),
    strict("strict-exact-disabled", "count_points", "points/count", '{"exact":true}', 400),
    strict("strict-approximate-count", "count_points", "points/count", '{"exact":false}', 200),
    {
      ...strict("strict-rate-limited", "count_points", "points/count", '{"exact":false}', 429, RATE_COLLECTION),
      attempts: 8,
    },
  ];
}

/** One capture per row of the error table that needs no credential (6.10). */
function errorCaptures(): CaptureSpec[] {
  const error = (
    name: string,
    op: string,
    method: "GET" | "POST",
    path: string,
    expectStatus: number,
    body?: string,
  ): CaptureSpec => ({
    service: "qdrant",
    name,
    group: "errors",
    surface: `${method} ${path}`,
    op,
    credential: "none",
    method,
    path,
    ...(body === undefined ? {} : { body }),
    expectStatus,
  });
  return [
    error("error-collection-not-found", "get_collection", "GET", `/collections/${HARNESS_PREFIX}missing`, 404),
    error("error-point-not-found", "get_point", "GET", "/collections/plain/points/999999", 404),
    error("error-format", "scroll_points", "POST", "/collections/plain/points/scroll", 400, '{"limit":"two"}'),
    error("error-validation", "scroll_points", "POST", "/collections/plain/points/scroll", 422, '{"limit":0}'),
    error(
      "error-wrong-input",
      "query_points",
      "POST",
      "/collections/plain/points/query",
      400,
      '{"query":[0.1,0.2],"limit":1}',
    ),
    error("error-id-as-string", "get_points", "POST", "/collections/docs/points", 400, '{"ids":["9007199254740993"]}'),
    error("error-post-without-body", "scroll_points", "POST", "/collections/plain/points/scroll", 400),
  ];
}

/**
 * QM12: the server's own answer to a misspelled filter clause, to a misspelled key beside a valid condition, and to a
 * misspelled top-level key, each beside the control that tells a dropped key from an honoured one. `plain` holds 300
 * points with `n` from 1 to 300, so `n == 1` counts 1; the range control shows what a `range` beside that match
 * counts when the server reads it, and the misspelled key counts the same as the first control when it is dropped.
 */
function filterCaptures(): CaptureSpec[] {
  const filter = (name: string, body: string, expectStatus?: number): CaptureSpec => ({
    service: "qdrant",
    name,
    group: "filters",
    surface: `points/count of plain with ${body}`,
    op: "count_points",
    credential: "none",
    method: "POST",
    path: "/collections/plain/points/count",
    body,
    ...(expectStatus === undefined ? {} : { expectStatus }),
  });
  return [
    filter("filter-control", '{"filter":{"must":[{"key":"n","match":{"value":1}}]},"exact":true}', 200),
    filter(
      "filter-range-control",
      '{"filter":{"must":[{"key":"n","match":{"value":1},"range":{"gt":5}}]},"exact":true}',
      200,
    ),
    filter("filter-misspelled-clause", '{"filter":{"must_nto":[]},"exact":true}'),
    filter(
      "filter-misspelled-condition-key",
      '{"filter":{"must":[{"key":"n","match":{"value":1},"rnage":{"gt":0}}]},"exact":true}',
    ),
    filter(
      "filter-misspelled-excluding-key",
      '{"filter":{"must":[{"key":"n","match":{"value":1},"rnage":{"gt":5}}]},"exact":true}',
    ),
    filter("filter-misspelled-top-level-key", '{"fliter":{"must":[{"key":"n","match":{"value":1}}]},"exact":true}'),
  ];
}

/** The TLS rows on `qdrant-tls` and `qdrant-mtls` (QE6). */
function tlsCaptures(): CaptureSpec[] {
  const row = (
    service: "qdrant-tls" | "qdrant-mtls",
    name: string,
    credential: CredentialName,
    path: string,
    tls: CaptureTls,
    expect: number | "no-answer",
  ): CaptureSpec => ({
    service,
    name,
    group: "tls",
    surface: `GET ${path} to ${tls.host} with ${credential}, ${tls.plaintext ? "plain HTTP" : tls.ca ? "the CA" : "no CA"}${tls.clientCertificate ? " and the client certificate" : ""}`,
    op: path === "/" ? "root" : "get_collections",
    credential,
    method: "GET",
    path,
    tls,
    ...(expect === "no-answer" ? { expectNoAnswer: true as const } : { expectStatus: expect }),
  });
  const byName: CaptureTls = { host: "localhost", ca: true, clientCertificate: false };
  const withClient: CaptureTls = { host: "localhost", ca: true, clientCertificate: true };
  return [
    row("qdrant-tls", "tls-root-by-name", "none", "/", byName, 200),
    row("qdrant-tls", "tls-root-by-address", "none", "/", { ...byName, host: "127.0.0.1" }, 200),
    row("qdrant-tls", "tls-admin-key-get-collections", "admin-key", "/collections", byName, 200),
    row("qdrant-tls", "tls-read-only-key-get-collections", "read-only-key", "/collections", byName, 200),
    row("qdrant-tls", "tls-wrong-key-get-collections", "wrong-key", "/collections", byName, 401),
    row("qdrant-tls", "tls-none-get-collections", "none", "/collections", byName, 401),
    row("qdrant-tls", "tls-no-ca", "none", "/", { ...byName, ca: false }, "no-answer"),
    row("qdrant-tls", "tls-plain-http-to-tls-port", "none", "/", { ...byName, plaintext: true }, "no-answer"),
    row("qdrant-mtls", "mtls-root-with-client-certificate", "none", "/", withClient, 200),
    row("qdrant-mtls", "mtls-admin-key-get-collections", "admin-key", "/collections", withClient, 200),
    row("qdrant-mtls", "mtls-no-client-certificate", "admin-key", "/collections", byName, "no-answer"),
  ];
}

/** Every capture, in the order the harness runs them. */
export function qdrantCatalog(
  routes: readonly FixtureRoute[],
  ids: Readonly<Record<string, readonly string[]>> = {},
): CaptureSpec[] {
  return [
    ...routeCaptures(routes, ids),
    ...credentialCaptures(),
    ...aliasCaptures(),
    ...timeoutCaptures(),
    ...strictCaptures(),
    ...errorCaptures(),
    ...filterCaptures(),
    ...tlsCaptures(),
  ];
}

/** What a capture records in place of the credential header it sent. */
export function redactedHeaders(credential: CredentialName): Readonly<Record<string, string>> {
  if (credential === "none") return {};
  return { "api-key": credential.startsWith("jwt-") ? "<token>" : "<api-key>" };
}

/** Refuses a file that would hold any secret this run sent, a segment of a JWT, or a key or certificate. */
export function assertNoSecret(file: string, text: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    const forms = [secret, ...(secret.split(".").length === 3 ? secret.split(".").slice(1) : [])];
    for (const form of forms) {
      if (form !== "" && text.includes(form)) {
        throw new Error(`${file} would hold a credential this run sent: nothing written`);
      }
    }
  }
  if (/-----BEGIN|PRIVATE KEY/.test(text))
    throw new Error(`${file} would hold a key or a certificate: nothing written`);
}

export interface CaptureProvenance {
  readonly image: string;
  readonly digest: string;
  readonly version: string;
}

export type CapturePayload =
  | {
      readonly status: number;
      readonly contentType: string | null;
      readonly retryAfter: string | null;
      readonly bodyBytes: number;
      readonly body: string;
    }
  | { readonly error: { readonly code: string | null; readonly message: string } };

export interface CaptureRecord {
  readonly $captured: {
    readonly engine: "qdrant";
    readonly service: QdrantService;
    readonly image: string;
    readonly digest: string;
    readonly version: string;
    readonly date: string;
    readonly runtime: string;
    readonly surface: string;
    readonly op: string | null;
    readonly credential: CredentialName;
    /** How many times the request was sent before this answer; 1 unless the capture declares `attempts`. */
    readonly attempts: number;
    readonly request: {
      readonly method: "GET" | "POST";
      readonly path: string;
      readonly headers: Readonly<Record<string, string>>;
      /** The body as sent, a note in angle brackets where it is a long generated filter, or null. */
      readonly body: string | null;
    };
  };
  readonly outcome: "pass" | "fail";
  readonly payload: CapturePayload;
}

/** A capture as it is written: one surface, where and when it was asked, and a pass or the verbatim failure. */
export function captureRecord(
  spec: CaptureSpec,
  provenance: CaptureProvenance,
  run: { readonly date: string; readonly runtime: string; readonly attempts: number },
  payload: CapturePayload,
): CaptureRecord {
  return {
    $captured: {
      engine: "qdrant",
      service: spec.service,
      image: provenance.image,
      digest: provenance.digest,
      version: provenance.version,
      date: run.date,
      runtime: run.runtime,
      surface: spec.surface,
      op: spec.op,
      credential: spec.credential,
      attempts: run.attempts,
      request: {
        method: spec.method,
        path: spec.path,
        headers: redactedHeaders(spec.credential),
        body: spec.bodyNote !== undefined ? `<${spec.bodyNote}>` : (spec.body ?? null),
      },
    },
    outcome: "status" in payload && payload.status >= 200 && payload.status <= 299 ? "pass" : "fail",
    payload,
  };
}

/** Why an answer is not what its capture declares, or null where it is. */
export function captureProblem(spec: CaptureSpec, payload: CapturePayload): string | null {
  const where = `${spec.service}/${spec.name}`;
  if (spec.expectNoAnswer === true) {
    return "error" in payload ? null : `${where}: expected no HTTP answer, got HTTP ${payload.status}`;
  }
  if ("error" in payload) return `${where}: no HTTP answer: ${payload.error.code ?? ""} ${payload.error.message}`;
  if (spec.expectStatus !== undefined && payload.status !== spec.expectStatus) {
    return `${where}: expected HTTP ${spec.expectStatus}, got HTTP ${payload.status}: ${payload.body.slice(0, 300)}`;
  }
  return null;
}
