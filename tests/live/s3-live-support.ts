/**
 * The s3 provider's live acceptance in one module: the targets, the principals and
 * the connections built from them, the acceptance matrix `S3_ACCEPTANCE` as data, the resolver of the provider's own
 * sentences, the evaluator of one step, the matrix renderer, and (below) the scenario runners.
 *
 * tests/live/s3-live-check.ts, tests/live/s3-evidence.ts and tests/integration/db/s3-provider.test.ts all read this
 * module, so the live check, the harness and the replay run the same function for a row. docs/providers/s3.md carries
 * the matrix rendered by `renderS3Acceptance`, and tests/unit/db/s3/live-environment.test.ts fails when they differ.
 *
 * A `sentence` is never retyped: it names how the provider's own text is obtained, and `resolveS3Sentence` obtains it
 * by calling the provider's code with the step's own connection, command or page options:
 *
 *   connection              the refusal buildS3ConnectionOptions throws for the step's connection
 *   console                 the refusal parseS3Command answers for the step's command, with the connection's context
 *   keys                    the refusal readS3KeyScanRequest throws for the step's page options and cursor
 *   egress:link-local:<h>   the refusal assertNotLinkLocalLiteral throws for host <h>
 *   egress:blocked:<h>      the refusal assertPublicLiteralHost throws for <h> with DB_HTTP_BLOCK_PRIVATE_HOSTS on
 *   endpoint:host:<h>       the refusal validateHost throws for <h>
 *   server:<json>           the message toProviderError gives an S3ServerError built from the measured answer <json>
 *   notice:<id>             the preview sentence <id> of S3_PREVIEW_SENTENCES, its placeholders matching any text
 *   not:<ref>               any refusal other than <ref>'s
 *
 * Loads under Node as well as Bun: the repository root is the working directory when import.meta.dir is absent.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { QueryCancelledError } from "@/lib/db/errors";
import { assertNotLinkLocalLiteral, assertPublicLiteralHost } from "@/lib/db/http/egress-policy";
import { validateHost } from "@/lib/db/http/endpoint";
import type { NodeByteTransportOptions, RequestSigner, SigningInput } from "@/lib/db/http/node-transport";
import { createS3Client } from "@/lib/db/providers/objectstore/s3/client";
import { buildS3ConnectionOptions, s3EndpointText } from "@/lib/db/providers/objectstore/s3/connection-options";
import { parseS3Command } from "@/lib/db/providers/objectstore/s3/console/commands";
import { S3_PREVIEW_DEFAULT_ROWS } from "@/lib/db/providers/objectstore/s3/constants";
import { S3ServerError, toProviderError } from "@/lib/db/providers/objectstore/s3/errors";
import { S3_RESPONSE_HEADERS } from "@/lib/db/providers/objectstore/s3/headers";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import { readS3KeyScanRequest } from "@/lib/db/providers/objectstore/s3/key-scan";
import { joinVirtualKey } from "@/lib/db/providers/objectstore/s3/names";
import { S3_PREVIEW_SENTENCES } from "@/lib/db/providers/objectstore/s3/preview-render";
import { s3Signer } from "@/lib/db/providers/objectstore/s3/sigv4";
import type { DatabaseProvider, KeyScanOptions, KeyScanPage } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import type { ObjectSurfaceExpectation } from "../helpers/object-surface-conformance";
import { normalizeMessage, type S3FixtureSecret } from "../helpers/s3-evidence-scrub";
import {
  answerOf,
  recordedRequest,
  recordingSigner,
  type S3Exchange,
  type S3RecordedRequest,
  type S3TransportFactory,
  signingInput,
} from "../helpers/s3-wire";

export const ROOT: string =
  typeof import.meta.dir === "string" ? path.resolve(import.meta.dir, "../..") : process.cwd();
if (!existsSync(path.join(ROOT, "database-compose.yml")))
  throw new Error("Run this from the repository root: database-compose.yml is not here.");

// ============================================================================
// Targets and principals
// ============================================================================

export type S3Target = "minio" | "minio-region" | "silo" | "silo-tls" | "garage" | "rustfs";
export const S3_TARGET_NAMES: readonly S3Target[] = ["minio", "minio-region", "silo", "silo-tls", "garage", "rustfs"];
/** The columns the matrix renders; silo-tls runs A1, A2, A14, A37 and A57 as on Silo. */
export const S3_MATRIX_COLUMNS = ["minio", "minio-region", "silo", "garage", "rustfs"] as const;
export type S3Server = "minio" | "silo" | "garage" | "rustfs";

export interface S3TargetSpec {
  readonly label: string;
  readonly port: number;
  readonly tls: boolean;
  /** The signing region every connection of the target writes. */
  readonly region: string;
  /** Which column of seed.sh's special-key table holds this target's outcomes. */
  readonly server: S3Server;
  readonly profile?: string;
}

export const S3_TARGETS: Readonly<Record<S3Target, S3TargetSpec>> = {
  minio: { label: "MinIO", port: 9000, tls: false, region: "us-east-1", server: "minio", profile: "s3-minio" },
  "minio-region": {
    label: "MinIO-R",
    port: 9030,
    tls: false,
    region: "eu-central-1",
    server: "minio",
    profile: "s3-region",
  },
  silo: { label: "Silo", port: 9010, tls: false, region: "us-east-1", server: "silo" },
  "silo-tls": { label: "Silo TLS", port: 9443, tls: true, region: "us-east-1", server: "silo", profile: "s3-tls" },
  garage: { label: "Garage", port: 3900, tls: false, region: "garage", server: "garage" },
  rustfs: { label: "RustFS", port: 9020, tls: false, region: "us-east-1", server: "rustfs" },
};

export type S3Role = "root" | "browse" | "scoped" | "getonly";
export const S3_ROLES: readonly S3Role[] = ["root", "browse", "scoped", "getonly"];
export interface S3Principal {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}
export type S3Principals = Readonly<Record<S3Role, S3Principal>>;
const GARAGE_SECRET_FILES: Readonly<Record<S3Role, string>> = {
  root: "rw.secret",
  browse: "browse.secret",
  scoped: "scoped.secret",
  getonly: "none.secret",
};

/** The principals table of docker/s3/README.md: access key, password and Garage key id per role. */
export function readmeRows(): Readonly<Record<S3Role, { accessKeyId: string; secret: string; garageKeyId: string }>> {
  const rows: Partial<Record<S3Role, { accessKeyId: string; secret: string; garageKeyId: string }>> = {};
  for (const line of readFileSync(path.join(ROOT, "docker/s3/README.md"), "utf8").split("\n")) {
    const row = /^\| (root|browse|scoped|getonly) \| `([^`]+)` \| `([^`]+)` \| `(GK[0-9a-f]{24})`/.exec(line);
    if (row) rows[row[1] as S3Role] = { accessKeyId: row[2], secret: row[3], garageKeyId: row[4] };
  }
  for (const role of S3_ROLES)
    if (rows[role] === undefined) throw new Error(`docker/s3/README.md has no principals row for ${role}`);
  return rows as Readonly<Record<S3Role, { accessKeyId: string; secret: string; garageKeyId: string }>>;
}

/**
 * The principals of a target: the README's for the MinIO lineage and RustFS, whose root must be the compose file's;
 * for Garage the README's key ids and the secrets read from a copy of the s3-garage-keys volume.
 */
export function readS3Principals(target: S3Target, garageKeysDir?: string): S3Principals {
  const rows = readmeRows();
  if (target === "garage") {
    if (garageKeysDir === undefined)
      throw new Error("Pass --garage-keys <copy of the s3-garage-keys volume> for the Garage target.");
    return Object.fromEntries(
      S3_ROLES.map((role) => [
        role,
        {
          accessKeyId: rows[role].garageKeyId,
          secretAccessKey: readFileSync(path.join(garageKeysDir, GARAGE_SECRET_FILES[role]), "utf8").trim(),
        },
      ]),
    ) as unknown as S3Principals;
  }
  const compose = parseYaml(readFileSync(path.join(ROOT, "database-compose.yml"), "utf8"), { merge: true }) as {
    services: Record<string, { environment?: Record<string, string> }>;
  };
  const env = compose.services.minio?.environment ?? {};
  if (env.MINIO_ROOT_USER !== rows.root.accessKeyId || env.MINIO_ROOT_PASSWORD !== rows.root.secret)
    throw new Error("docker/s3/README.md's root principal is not database-compose.yml's MinIO root");
  return Object.fromEntries(
    S3_ROLES.map((role) => [role, { accessKeyId: rows[role].accessKeyId, secretAccessKey: rows[role].secret }]),
  ) as unknown as S3Principals;
}

/** The replay signs nothing a server checks: the README's ids, and for Garage a stand-in secret, since no capture holds a signature. */
export function replayPrincipals(target: S3Target): S3Principals {
  if (target !== "garage") return readS3Principals(target);
  const rows = readmeRows();
  return Object.fromEntries(
    S3_ROLES.map((role) => [
      role,
      { accessKeyId: rows[role].garageKeyId, secretAccessKey: `replayed-garage-${role}-secret` },
    ]),
  ) as unknown as S3Principals;
}

/** Every fixture secret of the given principals, labelled, for the scrub and row A65. */
export function fixtureSecrets(target: S3Target, principals: S3Principals): S3FixtureSecret[] {
  return S3_ROLES.map((role) => ({ label: `${target} ${role} secret`, value: principals[role].secretAccessKey }));
}

export interface S3ConnectionPlan {
  readonly role: S3Role;
  /** The pinned bucket (the database field). */
  readonly pin?: string;
  /** Another signing region than the target's. */
  readonly region?: string;
  /** Another host than 127.0.0.1 (A55, A56). */
  readonly host?: string;
  /** Replaces the role's secret (A4). */
  readonly secret?: string;
  /** Replaces the role's access key id (A5). */
  readonly accessKeyId?: string;
  /** A blank key pair (A9). */
  readonly anonymous?: true;
  readonly readOnly?: boolean;
  readonly allowInsecureAuth?: true;
}

export function s3LiveConnection(
  target: S3Target,
  principals: S3Principals,
  plan: S3ConnectionPlan,
  ca?: string,
): DatabaseConnection {
  const spec = S3_TARGETS[target];
  const principal = principals[plan.role];
  if (spec.tls && ca === undefined)
    throw new Error("Pass --ca <copy of the s3-certs volume>/ca.pem for the silo-tls target.");
  return {
    id: `s3-live-${target}-${plan.role}`,
    name: `S3 live ${spec.label} ${plan.role}`,
    type: "s3",
    host: plan.host ?? "127.0.0.1",
    port: spec.port,
    user: plan.anonymous ? "" : (plan.accessKeyId ?? principal.accessKeyId),
    password: plan.anonymous ? "" : (plan.secret ?? principal.secretAccessKey),
    ...(plan.pin === undefined ? {} : { database: plan.pin }),
    region: plan.region ?? spec.region,
    readOnly: plan.readOnly ?? true,
    ...(plan.allowInsecureAuth ? { allowInsecureAuth: true } : {}),
    ...(spec.tls ? { ssl: { mode: "verify-full" as const, caCert: ca } } : {}),
    createdAt: new Date(0),
  } as DatabaseConnection;
}

// ============================================================================
// The special keys of docker/s3/seed.sh, the one source of each server's outcome
// ============================================================================

export interface S3SpecialKey {
  /** The key as stored, decoded from the wire form. */
  readonly key: string;
  readonly wire: string;
  readonly outcomes: Readonly<Record<S3Server, string>>;
}

function seg(n: number): string {
  return "abcdefghijklmnopqrstuvwxyz".repeat(10).slice(0, n);
}

function decodeWire(wire: string): string {
  const bytes: number[] = [];
  for (let at = 0; at < wire.length; at++) {
    if (wire[at] === "%") {
      bytes.push(Number.parseInt(wire.slice(at + 1, at + 3), 16));
      at += 2;
    } else bytes.push(wire.charCodeAt(at));
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
}

export const S3_SPECIAL_KEYS: readonly S3SpecialKey[] = (() => {
  const script = readFileSync(path.join(ROOT, "docker/s3/seed.sh"), "utf8");
  const table = /^SPECIAL_KEYS='\n([\s\S]*?)\n'$/m.exec(script)?.[1] ?? "";
  const long = `${seg(250)}/${seg(250)}/${seg(250)}/${seg(245)}`;
  return table
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [rawWire, minio, silo, garage, rustfs] = line.split("|");
      const wire = rawWire.replace("@LONG@", long);
      return { key: decodeWire(wire), wire, outcomes: { minio, silo, garage, rustfs } };
    });
})();

const DOT_KEYS = new Set(["sp/double//slash.txt", "sp/./dot.txt", "sp/x/../dotdot.txt"]);

function bytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** The stored special keys of a server, `studio-demo/`-joined, byte order; the dot-segment keys are row A19's. */
export function storedSpecialKeys(server: S3Server, where: "sp" | "all"): string[] {
  return S3_SPECIAL_KEYS.filter((special) => special.outcomes[server] === "stored" && !DOT_KEYS.has(special.key))
    .filter((special) => where === "all" || special.key.startsWith("sp/"))
    .map((special) => `studio-demo/${special.key}`)
    .sort(bytewise);
}

export function storedDotKeys(server: S3Server): string[] {
  return S3_SPECIAL_KEYS.filter((special) => special.outcomes[server] === "stored" && DOT_KEYS.has(special.key)).map(
    (special) => special.key,
  );
}

export function seedOutcome(server: S3Server, key: string): string {
  const special = S3_SPECIAL_KEYS.find((row) => row.key === key);
  if (special === undefined) throw new Error(`seed.sh's SPECIAL_KEYS has no ${JSON.stringify(key)}`);
  return special.outcomes[server];
}

// ============================================================================
// The acceptance matrix
// ============================================================================

/** A structured check, evaluated by s3-live-support.ts against the runner's summary of one step. */
export type S3Check =
  | { readonly rows: number }
  | { readonly names: readonly string[] }
  | { readonly pages: readonly number[]; readonly noRepeat: true }
  | { readonly headers: Readonly<Record<string, string>> }
  /** `names`, when given, must equal the observed names exactly and in order: the columns a preview kept. */
  | { readonly notice: string; readonly rows?: number; readonly names?: readonly string[] }
  | { readonly exchanges: 0 };

export type S3Expectation =
  /** `detail` is what the doc renders; `check` is what the live check and the replay compare. */
  | { readonly kind: "ok"; readonly detail: string; readonly check: S3Check }
  /** Refused with the sentence the provider exports under `sentence`; `names` must appear in it. */
  | { readonly kind: "refused"; readonly sentence: string; readonly names?: readonly string[] }
  /** Refused by the provider before any request: the transport records zero exchanges and zero sockets. */
  | { readonly kind: "refused-before-request"; readonly sentence: string }
  | { readonly kind: "not-applicable"; readonly why: string };

/** One step of a row; a row with one outcome per cell has one step. */
export interface S3Step {
  readonly step: string;
  readonly outcome: S3Expectation;
}

export interface S3AcceptanceRow {
  readonly id: `A${number}` | `A${number}${"b" | "p"}`;
  readonly behaviour: string;
  readonly expect: Readonly<Record<S3Target, readonly S3Step[]>>;
  /** Where each cell's outcome comes from: a server measured live, or the repository file that states the rule. */
  readonly evidence: readonly string[];
}

const ok = (detail: string, check: S3Check): S3Expectation => ({ kind: "ok", detail, check });
const refused = (sentence: string, names?: readonly string[]): S3Expectation =>
  names === undefined ? { kind: "refused", sentence } : { kind: "refused", sentence, names };
const before = (sentence: string): S3Expectation => ({ kind: "refused-before-request", sentence });
const na = (why: string): S3Expectation => ({ kind: "not-applicable", why });
const one = (outcome: S3Expectation, step = "run"): readonly S3Step[] => [{ step, outcome }];
const steps = (...pairs: readonly (readonly [string, S3Expectation])[]): readonly S3Step[] =>
  pairs.map(([step, outcome]) => ({ step, outcome }));
const holds = one({ kind: "ok", detail: "holds", check: { rows: 0 } });

/** The measured answer a refusal rests on, as the resolver builds it into an S3ServerError. */
function server(
  operation: string,
  status: number,
  code?: string,
  extra: Readonly<{
    message?: string;
    region?: string;
    bucket?: string;
    key?: string;
    method?: "GET" | "HEAD";
    sentToken?: boolean;
    anyNumber?: true;
  }> = {},
): string {
  return `server:${JSON.stringify({ operation, status, ...(code === undefined ? {} : { code }), ...extra })}`;
}

const SILO_TLS_ONLY = "silo-tls runs A1, A2, A14, A37 and A57 only, as on Silo";
type GivenCells = { readonly minio: readonly S3Step[] } & Partial<
  Record<Exclude<S3Target, "minio">, readonly S3Step[]>
>;

/** MinIO-R, Silo, Garage and RustFS take MinIO's cell unless given; silo-tls takes Silo's on the rows it runs. */
function cells(
  given: GivenCells,
  tls: "as-silo" | "not-run" = "not-run",
): Readonly<Record<S3Target, readonly S3Step[]>> {
  const silo = given.silo ?? given.minio;
  return {
    minio: given.minio,
    "minio-region": given["minio-region"] ?? given.minio,
    silo,
    "silo-tls": given["silo-tls"] ?? (tls === "as-silo" ? silo : one(na(SILO_TLS_ONLY))),
    garage: given.garage ?? given.minio,
    rustfs: given.rustfs ?? given.minio,
  };
}

/** One cell per server column of seed.sh's table, MinIO-R as MinIO and silo-tls not run. */
function perServer(build: (server: S3Server) => readonly S3Step[]): Readonly<Record<S3Target, readonly S3Step[]>> {
  return cells({ minio: build("minio"), silo: build("silo"), garage: build("garage"), rustfs: build("rustfs") });
}

/** The Field rows head-object answers for a seeded object, in the console's fixed order; a server may add others. */
const HEAD_OBJECT_FIELDS = ["ContentLength", "ETag", "LastModified", "ContentType"];
const HEAD_OBJECT_DETAIL =
  "head-object answers one Field row each for ContentLength, ETag, LastModified and ContentType";

const TOP_LEVEL = ["a/", "data/", "dir/", "keys/", "long/", "meta/", "parquet/", "sp/"].map(
  (name) => `studio-demo/${name}`,
);
const DATA_OBJECTS = 13;
const CODECS = ["uncompressed", "snappy", "gzip", "zstd", "brotli", "lz4_raw"] as const;

/**
 * A key's cell from seed.sh's table: `stored` when the server stored it, not applicable when the seed recorded a
 * refusal, and, until the first seed run replaces a `measure` cell (a rule of live-environment.test.ts holds that none
 * is left), not applicable with that reason.
 */
function seededKeyCell(server: S3Server, key: string, stored: S3Expectation): S3Expectation {
  const outcome = seedOutcome(server, key);
  if (outcome === "stored") return stored;
  if (/^[45]\d\d:/.test(outcome)) return na(`the server refused the key at seed with ${outcome.replace(":", " ")}`);
  return na("the first seed run records whether the server stores this key");
}

const LINK_LOCAL_HOSTS = [
  "169.254.169.254",
  "169.254.0.1",
  "fe80::1",
  "fd00:ec2::254",
  "::ffff:169.254.169.254",
  "64:ff9b::a9fe:a9fe",
] as const;
const NUMERIC_HOSTS = ["2852039166", "0xa9fea9fe"] as const;

/** The console refusals of row A51, by step name. */
export const A51_COMMANDS: Readonly<Record<string, string>> = {
  profile: "aws s3 ls s3://studio-demo/ --profile prod",
  "no-sign-request": "aws s3 ls s3://studio-demo/ --no-sign-request",
  "ca-bundle": "aws s3 ls s3://studio-demo/ --ca-bundle /tmp/ca.pem",
  "no-verify-ssl": "aws s3 ls s3://studio-demo/ --no-verify-ssl",
  debug: "aws s3 ls s3://studio-demo/ --debug",
  "region-mismatch": "aws s3 ls s3://studio-demo/ --region ap-south-1",
  "endpoint-mismatch": "aws s3 ls s3://studio-demo/ --endpoint-url http://127.0.0.1:1",
  "get-object-attributes":
    "aws s3api get-object-attributes --bucket studio-demo --key data/table.csv --object-attributes ETag",
  "get-object": "aws s3api get-object --bucket studio-demo --key data/table.csv out.csv",
  sync: "aws s3 sync s3://studio-demo/ ./copy",
  "key-too-long": `aws s3api head-object --bucket studio-demo --key ${"k".repeat(1025)}`,
  "key-nul": "aws s3api head-object --bucket studio-demo --key 'a\u0000b'",
  semicolon: "aws s3 ls s3://studio-demo/; aws s3 rm s3://studio-demo/root.txt",
  and: "aws s3 ls s3://studio-demo/ && aws s3 rm s3://studio-demo/root.txt",
  pipe: "aws s3 ls s3://studio-demo/ | aws s3 rm s3://studio-demo/root.txt",
  substitution: "aws s3 ls s3://studio-demo/$(aws s3 rm s3://studio-demo/root.txt)",
  "second-line": "aws s3 ls s3://studio-demo/\naws s3 rm s3://studio-demo/root.txt",
  "bucket-dotdot": "aws s3api head-object --bucket .. --key k",
  "bucket-space": "aws s3api head-object --bucket 'a b' --key k",
  "key-leading-slash": "aws s3api head-object --bucket studio-demo --key /x",
  "preview-empty-segment": "preview s3://studio-demo//x",
};

/** The write-shaped commands of row A50, by step name. */
export const A50_COMMANDS: Readonly<Record<string, string>> = {
  cp: "aws s3 cp ./local.txt s3://studio-demo/local.txt",
  rm: "aws s3 rm s3://studio-demo/root.txt",
  "put-object": "aws s3api put-object --bucket studio-demo --key x.txt --body x.txt",
  "delete-object": "aws s3api delete-object --bucket studio-demo --key root.txt",
  "create-bucket": "aws s3api create-bucket --bucket studio-new",
};

/** The forged starting tokens of row A66, by step name. */
export const A66_TOKENS: Readonly<Record<string, string>> = {
  random: "q8dZ1vJ0mK3wR7pL",
  array: Buffer.from(JSON.stringify(["a", "b"])).toString("base64"),
  "extra-key": Buffer.from(JSON.stringify({ ContinuationToken: "x", extra: 1 })).toString("base64"),
  "boto-encoded-keys": Buffer.from(
    JSON.stringify({ ContinuationToken: "x", boto_encoded_keys: [["ContinuationToken"]] }),
  ).toString("base64"),
};

export const S3_ACCEPTANCE: readonly S3AcceptanceRow[] = [
  // Connection and Test Connection
  {
    id: "A1",
    behaviour: "Test Connection, root, no pin (ListBuckets, whose answer must parse as ListAllMyBucketsResult)",
    expect: cells({ minio: one(ok("ok, 5 buckets", { rows: 5 }), "test") }, "as-silo"),
    evidence: ["MinIO, measured live", "Silo, measured live", "Garage, measured live", "RustFS, measured live"],
  },
  {
    id: "A2",
    behaviour:
      "Test Connection, root, pinned studio-demo: connect and the health read each send one ListObjectsV2 on the pin with max-keys=1, delimiter=/ and encoding-type=url, and no HEAD",
    expect: cells(
      {
        minio: one(
          ok(
            "ok: two ListObjectsV2, connect's probe and the health read's, each with max-keys=1, delimiter=/ and encoding-type=url, no HEAD",
            {
              headers: {
                requests: "2",
                method: "GET",
                "same probe": "yes",
                "max-keys": "1",
                delimiter: "/",
                "encoding-type": "url",
              },
            },
          ),
          "test",
        ),
      },
      "as-silo",
    ),
    evidence: ["docs/providers/s3.md", "Garage, measured live", "RustFS, measured live", "first live run, 2026-10-10"],
  },
  {
    id: "A3",
    behaviour: "Pinned no-such-bucket, root (the ListObjectsV2 probe of A2)",
    expect: cells({
      minio: one(
        refused(server("ListObjectsV2", 404, "NoSuchBucket", { bucket: "no-such-bucket" }), ["no-such-bucket"]),
        "test",
      ),
    }),
    evidence: ["MinIO, measured live", "Garage, measured live", "RustFS, measured live"],
  },
  {
    id: "A4",
    behaviour: "Wrong secret, no pin",
    expect: cells({
      minio: one(refused(server("ListBuckets", 403, "SignatureDoesNotMatch")), "test"),
      garage: one(
        refused(server("ListBuckets", 403, "AccessDenied", { message: "Forbidden: Invalid signature" })),
        "test",
      ),
    }),
    evidence: ["MinIO, measured live", "Garage, measured live", "RustFS, measured live"],
  },
  {
    id: "A4p",
    behaviour:
      "Wrong secret, pinned: the ListObjectsV2 probe carries the error code in its body, so connect sends one GET and no follow-up",
    expect: cells({
      minio: one(refused(server("ListObjectsV2", 403, "SignatureDoesNotMatch", { bucket: "studio-demo" })), "test"),
      garage: one(
        refused(
          server("ListObjectsV2", 403, "AccessDenied", {
            message: "Forbidden: Invalid signature",
            bucket: "studio-demo",
          }),
        ),
        "test",
      ),
    }),
    evidence: ["docs/providers/s3.md", "Garage, measured live", "RustFS, measured live"],
  },
  {
    id: "A5",
    behaviour: "Unknown access key GKffffffffffffffffffffffff",
    expect: cells({
      minio: one(refused(server("ListBuckets", 403, "InvalidAccessKeyId")), "test"),
      garage: one(
        refused(
          server("ListBuckets", 403, "AccessDenied", { message: "Forbidden: No such key: GKffffffffffffffffffffffff" }),
        ),
        "test",
      ),
    }),
    evidence: ["MinIO, measured live", "Garage, measured live", "RustFS, measured live"],
  },
  {
    id: "A6",
    behaviour: "Connection region us-east-1 (the default), browse studio-demo",
    expect: cells({
      minio: one(ok("ok (any region accepted)", { names: ["studio-demo/root.txt"] }), "browse"),
      "minio-region": one(
        refused(
          server("ListObjectsV2", 400, "AuthorizationHeaderMalformed", {
            region: "eu-central-1",
            bucket: "studio-demo",
          }),
          ["eu-central-1"],
        ),
        "browse",
      ),
      // Garage enforces the region on every call, so the session's connect probe (ListBuckets) is the refused request.
      garage: one(
        refused(server("ListBuckets", 400, "AuthorizationHeaderMalformed", { region: "garage" }), ["garage"]),
        "browse",
      ),
    }),
    evidence: ["AWS S3 behaviour as documented", "Garage, measured live", "RustFS, measured live"],
  },
  {
    id: "A7",
    behaviour: "Connection region not-a-region (negative control), browse studio-demo",
    expect: cells({
      minio: one(ok("ok", { names: ["studio-demo/root.txt"] }), "browse"),
      "minio-region": one(
        refused(
          server("ListObjectsV2", 400, "AuthorizationHeaderMalformed", {
            region: "eu-central-1",
            bucket: "studio-demo",
          }),
          ["eu-central-1"],
        ),
        "browse",
      ),
      // Garage enforces the region on every call, so the session's connect probe (ListBuckets) is the refused request.
      garage: one(
        refused(server("ListBuckets", 400, "AuthorizationHeaderMalformed", { region: "garage" }), ["garage"]),
        "browse",
      ),
      rustfs: one(
        ok("ok, recorded as: RustFS does not enforce the region", { names: ["studio-demo/root.txt"] }),
        "browse",
      ),
    }),
    evidence: ["RustFS, measured live", "Garage, measured live"],
  },
  {
    id: "A8",
    behaviour: "Clock 20 minutes ahead; on Garage also 25 hours behind",
    expect: cells({
      minio: one(refused(server("ListBuckets", 403, "RequestTimeTooSkewed", { anyNumber: true })), "ahead"),
      garage: steps(
        ["ahead", ok("ok (no future bound)", { rows: 5 })],
        [
          "behind",
          refused(
            server("ListBuckets", 400, "InvalidRequest", {
              message: "Bad request: Date is too old",
              anyNumber: true,
            }),
          ),
        ],
      ),
    }),
    evidence: ["Silo, measured live", "Garage, measured live", "RustFS, measured live", "first live run, 2026-10-10"],
  },
  {
    id: "A9",
    behaviour:
      "Blank key pair, with every ambient AWS credential source set in the check's own process: the request carries no authorization and no x-amz header, and the canary listener counts no connection",
    expect: cells({
      minio: steps(
        ["anonymous", refused(server("ListBuckets", 403, "AccessDenied"))],
        [
          "unsigned",
          ok("no authorization, no x-amz header, no canary connection", {
            headers: { authorization: "absent", "x-amz-headers": "0", canary: "0" },
          }),
        ],
      ),
      garage: steps(
        [
          "anonymous",
          refused(
            server("ListBuckets", 403, "AccessDenied", {
              message: "Forbidden: Garage does not support anonymous access yet",
            }),
          ),
        ],
        [
          "unsigned",
          ok("no authorization, no x-amz header, no canary connection", {
            headers: { authorization: "absent", "x-amz-headers": "0", canary: "0" },
          }),
        ],
      ),
    }),
    evidence: ["MinIO, measured live", "Garage, measured live", "docs/providers/s3.md"],
  },
  {
    id: "A10",
    behaviour: "Scoped principal pinned to studio-demo, then to no-such-bucket (the ListObjectsV2 probe)",
    expect: cells({
      minio: steps(
        ["studio-demo", refused(server("ListObjectsV2", 403, "AccessDenied", { bucket: "studio-demo" }))],
        ["no-such-bucket", refused(server("ListObjectsV2", 403, "AccessDenied", { bucket: "no-such-bucket" }))],
      ),
      garage: steps(
        ["studio-demo", refused(server("ListObjectsV2", 403, "AccessDenied", { bucket: "studio-demo" }))],
        [
          "no-such-bucket",
          refused(server("ListObjectsV2", 404, "NoSuchBucket", { bucket: "no-such-bucket" }), ["no-such-bucket"]),
        ],
      ),
    }),
    evidence: ["AWS S3 behaviour as documented", "Garage, measured live", "RustFS, measured live"],
  },
  {
    id: "A11",
    behaviour:
      "Getonly principal, no pin: ListBuckets, open studio-demo, head-object of data/table.csv; then Test Connection pinned to studio-demo",
    expect: cells({
      minio: steps(
        ["list", ok("buckets listed, filtered by the policy", { rows: 5 })],
        ["open", refused(server("ListObjectsV2", 403, "AccessDenied", { bucket: "studio-demo" }))],
        ["head", ok(HEAD_OBJECT_DETAIL, { names: HEAD_OBJECT_FIELDS })],
        ["pinned", refused(server("ListObjectsV2", 403, "AccessDenied", { bucket: "studio-demo" }))],
      ),
      garage: steps(
        ["list", na("the none key sees no bucket; A12 covers it")],
        ["open", na("the none key sees no bucket; A12 covers it")],
        ["head", na("the none key sees no bucket; A12 covers it")],
        ["pinned", refused(server("ListObjectsV2", 403, "AccessDenied", { bucket: "studio-demo" }))],
      ),
    }),
    evidence: [
      "AWS S3 behaviour as documented",
      "Garage, measured live",
      "RustFS, measured live",
      "first live run, 2026-10-10",
    ],
  },
  {
    id: "A12",
    behaviour: "Scoped principal, no pin: ListBuckets; on Garage also the none key",
    expect: cells({
      minio: one(ok("studio-scoped only", { names: ["studio-scoped"] }), "scoped"),
      garage: steps(
        [
          "scoped",
          ok("scoped-local and studio-scoped, the same bucket under two names", {
            names: ["scoped-local", "studio-scoped"],
          }),
        ],
        ["none", ok("an empty list", { rows: 0 })],
      ),
    }),
    evidence: ["AWS S3 behaviour as documented", "Garage, measured live"],
  },
  {
    id: "A55",
    behaviour:
      "Endpoints 169.254.169.254, 169.254.0.1, [fe80::1], [fd00:ec2::254], [::ffff:169.254.169.254] and [64:ff9b::a9fe:a9fe], with Connect without TLS ticked and DB_HTTP_BLOCK_PRIVATE_HOSTS unset and again false; then 2852039166 and 0xa9fea9fe",
    expect: cells({
      minio: [
        ...LINK_LOCAL_HOSTS.flatMap((host) => [
          { step: `${host} unset`, outcome: before(`egress:link-local:${host}`) },
          { step: `${host} false`, outcome: before(`egress:link-local:${host}`) },
        ]),
        ...NUMERIC_HOSTS.map((host) => ({ step: host, outcome: before(`endpoint:host:${host}`) })),
      ],
    }),
    evidence: ["docs/providers/s3.md", "src/lib/db/http/endpoint.ts:50-95"],
  },
  {
    id: "A55b",
    behaviour: "DB_HTTP_BLOCK_PRIVATE_HOSTS=true, root, 127.0.0.1",
    expect: cells({ minio: one(before("egress:blocked:127.0.0.1"), "blocked") }),
    evidence: ["docs/providers/s3.md", "src/lib/db/http/egress-policy.ts:12"],
  },
  {
    id: "A63",
    behaviour:
      "Through an SSH tunnel to silo (plain HTTP, no consent); then to silo-tls with verify-full; then a far end 169.254.169.254",
    expect: cells({
      minio: one(na("tunnel check only, on Silo")),
      silo: steps(
        ["plain", ok("Test Connection and a bucket listing succeed through the tunnel, no consent asked", { rows: 5 })],
        ["tls", ok("the certificate is checked against silo-tls and the listing succeeds", { rows: 5 })],
        ["link-local", before("egress:link-local:169.254.169.254")],
      ),
    }),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A56",
    behaviour: "Endpoint on the host's first non-loopback IPv4, plain HTTP, no consent; then with consent",
    expect: cells({
      minio: steps(["no-consent", before("connection")], ["consent", refused("not:connection")]),
    }),
    evidence: ["docs/providers/s3.md"],
  },
  // Listing and the Keys panel
  {
    id: "A13",
    behaviour: "Buckets in the sidebar, root",
    expect: cells({
      minio: one(
        ok("5 rows, sorted bytewise", {
          names: ["studio-bulk", "studio-demo", "studio-empty", "studio-scoped", "studio-versions"],
        }),
        "list",
      ),
      garage: one(
        ok("5 rows, sorted by the provider although Garage answers in random order", {
          names: ["studio-bulk", "studio-demo", "studio-empty", "studio-scoped", "studio-versions"],
        }),
        "list",
      ),
    }),
    evidence: ["Garage, measured live"],
  },
  {
    id: "A14",
    behaviour: "studio-demo top level",
    expect: cells(
      {
        minio: one(
          ok("folders a/, data/, dir/, keys/, long/, meta/, parquet/, sp/ (and ctl/ where stored), then root.txt", {
            names: [...TOP_LEVEL, "studio-demo/root.txt"],
          }),
          "level",
        ),
      },
      "as-silo",
    ),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A15",
    behaviour: "Folder marker dir/",
    expect: cells({
      minio: one(
        ok("inside dir/: the marker row dir/ and child.txt", {
          names: ["studio-demo/dir/", "studio-demo/dir/child.txt"],
        }),
        "level",
      ),
    }),
    evidence: ["docs/providers/s3.md", "RustFS, measured live"],
  },
  {
    id: "A16",
    behaviour: "Marker with a body, keys/dirmarker/",
    expect: cells({
      minio: steps(
        [
          "level",
          ok("inside the folder, the marker row with size 9, never hidden", {
            headers: { "studio-demo/keys/dirmarker/": "9 B" },
          }),
        ],
        ["open", ok("its metadata and its preview (marker!!)", { headers: { size_bytes: "9", preview: "marker!!" } })],
      ),
    }),
    evidence: ["docs/providers/s3.md", "MinIO, measured live"],
  },
  {
    id: "A17",
    behaviour: "Special keys of docker/s3/seed.sh listed under their exact names and opened",
    expect: perServer((server) =>
      steps(
        ["list", ok("each stored key listed under its exact name", { names: storedSpecialKeys(server, "sp") })],
        ["open", ok("its HEAD and preview succeed", { rows: storedSpecialKeys(server, "all").length })],
      ),
    ),
    evidence: ["MinIO, measured live", "Garage, measured live", "RustFS, measured live"],
  },
  {
    id: "A17b",
    behaviour: "Keys panel prefix sp/with space, and list-objects-v2 with --prefix 'sp/*'",
    expect: cells({
      minio: steps(
        ["keys", ok("answered, names decoded", { names: ["studio-demo/sp/with space.txt"] })],
        ["console", ok("answered, * sent as %2A", { headers: { prefix: "sp%2F%2A" } })],
      ),
    }),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A18",
    behaviour: "Tab and U+0001 keys",
    expect: perServer((server) =>
      steps(
        [
          "tab",
          seededKeyCell(
            server,
            "sp/tab\tchar.txt",
            ok("listed and opened", { names: ["studio-demo/sp/tab\tchar.txt"] }),
          ),
        ],
        [
          "control",
          seededKeyCell(
            server,
            "ctl/x\u0001y.txt",
            ok("listed and opened", { names: ["studio-demo/ctl/x\u0001y.txt"] }),
          ),
        ],
      ),
    ),
    evidence: ["Garage, measured live"],
  },
  {
    id: "A19",
    behaviour: "//, . and .. keys",
    expect: perServer((server) =>
      storedDotKeys(server).length === 0
        ? steps(["list", ok("not present (refused at seed)", { rows: 0 })], ["open", na("no such key is stored")])
        : steps(
            ["list", ok("listed exactly, never normalised", { rows: storedDotKeys(server).length })],
            [
              "open",
              ok("opened under the key rule of the provider's addressing part", { rows: storedDotKeys(server).length }),
            ],
          ),
    ),
    evidence: ["AWS S3 behaviour as documented", "Garage, measured live", "RustFS, measured live"],
  },
  {
    id: "A20",
    behaviour: "Console head-object of a key starting with /",
    expect: cells({ minio: one(before("console"), "head") }),
    evidence: ["Silo, measured live", "Garage, measured live", "RustFS, measured live"],
  },
  {
    id: "A21",
    behaviour: "studio-bulk/many/: 2,500 objects",
    expect: cells({
      minio: one(
        ok("first page 1,000; Load more 1,000, then 500; no repeat; byte order", {
          pages: [1000, 1000, 500],
          noRepeat: true,
        }),
        "level",
      ),
    }),
    evidence: ["MinIO, measured live", "Garage, measured live", "RustFS, measured live"],
  },
  {
    id: "A22",
    behaviour: "studio-bulk/folders/: 1,100 folders",
    expect: cells({
      minio: one(
        ok("every folder exactly once; page 1 holds 1,000 folders and the next 100", {
          pages: [1000, 100],
          noRepeat: true,
        }),
        "level",
      ),
    }),
    evidence: ["MinIO, measured live"],
  },
  {
    id: "A23",
    behaviour: "studio-bulk/mixed/: 600 objects and 600 folders interleaved",
    expect: cells({
      minio: one(
        ok("every object and folder once; a page that ends on a folder resumes after it", {
          pages: [1000, 200],
          noRepeat: true,
        }),
        "level",
      ),
    }),
    evidence: ["MinIO, measured live"],
  },
  {
    id: "A23b",
    behaviour: "studio-versions level under ver/",
    expect: cells({
      minio: steps(
        [
          "level",
          ok("doc.txt and zz-last.txt present", {
            names: ["studio-versions/ver/doc.txt", "studio-versions/ver/zz-last.txt"],
          }),
        ],
        ["deleted", ok("deleted.txt absent", { rows: 0 })],
      ),
      garage: steps(["level", na("no versioning on Garage")], ["deleted", na("no versioning on Garage")]),
    }),
    evidence: ["docs/providers/s3.md", "Garage, measured live"],
  },
  {
    id: "A24",
    behaviour:
      "A cursor of the wrong shape handed to the Keys route: not the envelope's spelling, longer than S3_CURSOR_TEXT_MAX_CHARS, or JSON of another shape",
    expect: cells({ minio: steps(["spelling", before("keys")], ["long", before("keys")], ["shape", before("keys")]) }),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A24b",
    behaviour: "A cursor written by one provider instance handed to a second instance built for the same connection",
    // On studio-bulk/folders/, whose pages are about 65 KB, so the capture stays far under the 512 KiB exchange cap.
    expect: cells({
      minio: one(
        ok("accepted: the next page, no repeat and no gap", { pages: [1000, 100], noRepeat: true }),
        "handover",
      ),
    }),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A25",
    behaviour: "A cursor of studio-demo reused on studio-scoped or on another prefix",
    expect: cells({ minio: steps(["bucket", before("keys")], ["prefix", before("keys")]) }),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A26",
    behaviour: "No request carries max-keys=0 or above 1,000 (wire, every capture)",
    expect: cells({ minio: holds }),
    evidence: ["MinIO, measured live", "Garage, measured live"],
  },
  {
    id: "A27",
    behaviour: "No Keys panel request carries start-after (wire)",
    expect: cells({ minio: holds }),
    evidence: ["MinIO, measured live", "Garage, measured live"],
  },
  // Object metadata and preview
  {
    id: "A28",
    behaviour: "Source tab metadata of meta/tagged.txt and data/multipart.bin",
    expect: cells({
      minio: steps(
        [
          "tagged",
          ok("size, ETag, Last-Modified, Content-Type, both meta headers, tag count 2", {
            headers: {
              size_bytes: "12",
              content_type: "text/plain",
              "user_metadata.project": "libredb",
              "user_metadata.owner": "probe",
              tags: "env=probe&tier=gold",
            },
          }),
        ],
        ["multipart", ok("ETag with the -2 suffix", { headers: { size_bytes: "6291456", multipart_parts: "2" } })],
      ),
      garage: steps(
        [
          "tagged",
          ok("size, ETag, Last-Modified, Content-Type, both meta headers; no tag count", {
            headers: {
              size_bytes: "12",
              content_type: "text/plain",
              "user_metadata.project": "libredb",
              "user_metadata.owner": "probe",
              tags: "null",
            },
          }),
        ],
        ["multipart", ok("ETag with the -2 suffix", { headers: { size_bytes: "6291456", multipart_parts: "2" } })],
      ),
    }),
    evidence: ["Silo, measured live", "Garage, measured live", "RustFS, measured live"],
  },
  {
    id: "A29",
    behaviour: "Selecting a folder row sends no HEAD (wire)",
    expect: cells({ minio: holds }),
    evidence: ["MinIO, measured live"],
  },
  {
    id: "A30",
    behaviour: "Ranged read of data/one-mib.bin",
    expect: cells({
      minio: one(
        ok("206 with Content-Range, bytes shown as hex", {
          headers: { "range-status": "206", "preview-origin": "rendered" },
        }),
        "source",
      ),
    }),
    evidence: ["Garage, measured live", "RustFS, measured live"],
  },
  {
    id: "A31",
    behaviour: "Parquet footer by suffix range",
    expect: cells({ minio: one(ok("206", { headers: { "suffix-status": "206" } }), "source") }),
    evidence: ["AWS S3 behaviour as documented"],
  },
  {
    id: "A32",
    behaviour: "data/empty.txt",
    expect: cells({
      minio: one(
        ok("the Source tab says the object is empty; no error", { headers: { preview: "unavailable" } }),
        "source",
      ),
    }),
    evidence: ["Silo, measured live", "RustFS, measured live"],
  },
  {
    id: "A33",
    behaviour: "No request carries a multi-range header (wire)",
    expect: cells({ minio: holds }),
    evidence: ["RustFS, measured live"],
  },
  {
    id: "A35",
    behaviour: "data/rows.ndjson.gz with Content-Encoding: gzip",
    expect: cells({
      minio: one(
        ok("rows decoded from the stored gzip bytes, with notice N-GZIP", { notice: "notice:N-GZIP", rows: 3 }),
        "preview",
      ),
    }),
    evidence: ["MinIO, measured live", "docs/providers/s3.md"],
  },
  {
    id: "A35b",
    behaviour: "data/bomb.ndjson.gz: 64 MiB of NDJSON stored as about 64 KiB of gzip",
    expect: cells({
      minio: steps(
        [
          "preview",
          ok("rows from the first 1,000,000 decoded bytes only, within the row cap, with notice N-GZIP", {
            notice: "notice:N-GZIP",
            rows: S3_PREVIEW_DEFAULT_ROWS,
          }),
        ],
        ["gets", ok("one GET of the whole stored object", { rows: 1 })],
      ),
    }),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A36",
    behaviour: "data/rows.ndjson stored as application/octet-stream",
    expect: cells({
      minio: one(ok("previewed as NDJSON rows: detection by extension and content", { rows: 3 }), "preview"),
    }),
    evidence: ["MinIO, measured live"],
  },
  {
    id: "A37",
    behaviour: "Text, CSV (quoted comma and newline), TSV, JSON, truncated JSON, partial NDJSON, UTF-8 boundary",
    expect: cells(
      {
        minio: steps(
          ["csv", ok("4 records, the quoted comma and newline kept", { rows: 4 })],
          ["tsv", ok("4 records", { rows: 4 })],
          ["json", ok("the document as text lines", { rows: 1 })],
          ["truncated-json", ok("shown as text with notice N-JSON-CUT", { notice: "notice:N-JSON-CUT" })],
          ["partial-ndjson", ok("the cut last line stated with notice N-LINE-CUT", { notice: "notice:N-LINE-CUT" })],
          ["utf8-boundary", ok("cut back to a character boundary, with notice N-CUT", { notice: "notice:N-CUT" })],
        ),
      },
      "as-silo",
    ),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A38",
    behaviour: "parquet/fx-\\<codec\\>.parquet for the six codecs, fx-two-groups.parquet, fx-empty.parquet",
    expect: cells({
      minio: [
        ...CODECS.map((codec) => ({
          step: codec,
          outcome: ok("rows, including the struct and list columns", { rows: S3_PREVIEW_DEFAULT_ROWS }),
        })),
        { step: "two-groups", outcome: ok("notice N-PQ-RG0", { notice: "notice:N-PQ-RG0" }) },
        { step: "empty", outcome: ok("notice N-PQ-NO-ROWS", { notice: "notice:N-PQ-NO-ROWS" }) },
      ],
    }),
    evidence: ["Parquet preview, measured on Node and Bun"],
  },
  {
    id: "A39",
    behaviour: "parquet/large/narrow-zstd.parquet; parquet/large/wide-zstd.parquet",
    expect: cells({
      minio: steps(
        [
          "narrow",
          ok(
            "rows for the leading 4 of 5 columns (id, name, amount, d), with notice N-PQ-SOME-COLUMNS naming k = 4 of 5: the fifth passes the value cap",
            { notice: "notice:N-PQ-SOME-COLUMNS", rows: S3_PREVIEW_DEFAULT_ROWS, names: ["id", "name", "amount", "d"] },
          ),
        ],
        [
          "wide",
          ok(
            "rows for the leading 4 of 60 columns (c0_int, c1_str, c2_dbl, c3_date), with notice N-PQ-SOME-COLUMNS naming k = 4 of 60",
            {
              notice: "notice:N-PQ-SOME-COLUMNS",
              rows: S3_PREVIEW_DEFAULT_ROWS,
              names: ["c0_int", "c1_str", "c2_dbl", "c3_date"],
            },
          ),
        ],
      ),
    }),
    evidence: [
      "pyarrow and Polars default files, measured on Node and Bun",
      "docs/providers/s3.md",
      "tests/unit/db/s3/preview-parquet.test.ts: k = 4 of 5 and 4 of 60, and the kept names, over the files the raw seed writes, at the shipped limits",
      "the narrow file's fifth column passes the value cap, as a row group larger than the value caps does (docs/providers/s3.md, D274)",
      "first live run, 2026-10-10",
    ],
  },
  {
    id: "A40",
    behaviour: "parquet/bigcells-zstd.parquet",
    expect: cells({
      minio: steps(
        [
          "preview",
          ok("rows of the id column only, with notice N-PQ-SOME-COLUMNS", { notice: "notice:N-PQ-SOME-COLUMNS" }),
        ],
        ["wire", ok("no range request covers the 1 MB string column's chunk", { rows: 0 })],
      ),
    }),
    evidence: ["Parquet preview, measured on Node and Bun"],
  },
  {
    id: "A41",
    behaviour: "parquet/not-parquet.parquet, parquet/truncated.parquet",
    expect: cells({
      minio: steps(
        [
          "not-parquet",
          ok("not a Parquet file: hex with notice N-PQ-MAGIC; nothing else breaks", { notice: "notice:N-PQ-MAGIC" }),
        ],
        [
          "truncated",
          ok("not a readable Parquet file: hex with notice N-PQ-MAGIC; nothing else breaks", {
            notice: "notice:N-PQ-MAGIC",
          }),
        ],
      ),
    }),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A42",
    behaviour: "data/noext (no Content-Type)",
    expect: cells({
      minio: one(
        ok("shown as hex", { headers: { "preview-origin": "rendered", "preview-language": "plaintext" } }),
        "source",
      ),
    }),
    evidence: ["MinIO, measured live"],
  },
  {
    id: "A45",
    behaviour: "No request carries the attributes query (wire)",
    expect: cells({ minio: holds }),
    evidence: ["Garage, measured live", "docs/providers/s3.md"],
  },
  // Console
  {
    id: "A43",
    behaviour: "aws s3api list-object-versions --bucket studio-versions --prefix ver/",
    expect: cells({
      minio: one(
        ok("two versions of doc.txt, the delete marker and the version of deleted.txt, zz-last.txt", { rows: 5 }),
        "console",
      ),
      garage: one(
        refused(server("ListObjectVersions", 501, "NotImplemented", { bucket: "studio-versions" })),
        "console",
      ),
    }),
    evidence: ["Garage, measured live", "RustFS, measured live"],
  },
  {
    id: "A46",
    behaviour: "aws s3api list-buckets",
    expect: cells({ minio: one(ok("5 rows", { rows: 5 }), "console") }),
    evidence: ["MinIO, measured live"],
  },
  {
    id: "A47",
    behaviour:
      "aws s3 ls s3://studio-demo/, aws s3 ls s3://studio-demo/data/ --recursive, and the latter split over two lines with a backslash",
    expect: perServer((server) =>
      steps(
        [
          "top",
          ok("the top level of studio-demo", {
            rows: 9 + (seedOutcome(server, "ctl/x\u0001y.txt") === "stored" ? 1 : 0),
          }),
        ],
        ["recursive", ok("every object under data/", { rows: DATA_OBJECTS })],
        ["continued", ok("the same rows", { rows: DATA_OBJECTS })],
      ),
    ),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A48",
    behaviour: "aws s3api head-object --bucket studio-demo --key data/table.csv",
    expect: cells({ minio: one(ok(HEAD_OBJECT_DETAIL, { names: HEAD_OBJECT_FIELDS }), "console") }),
    evidence: ["docs/providers/s3.md", "first live run, 2026-10-10"],
  },
  {
    id: "A49",
    behaviour: "preview s3://studio-demo/data/table.csv, then preview s3://studio-demo/parquet/fx-zstd.parquet",
    expect: cells({
      minio: steps(["csv", ok("rows", { rows: 4 })], ["parquet", ok("rows", { rows: S3_PREVIEW_DEFAULT_ROWS })]),
    }),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A50",
    behaviour: "Every write-shaped command the console refuses",
    expect: cells({ minio: Object.keys(A50_COMMANDS).map((step) => ({ step, outcome: before("console") })) }),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A51",
    behaviour:
      "Every console refusal of a command it does not run, the one-command rule, and the refusals of an object address it cannot read",
    expect: cells({ minio: Object.keys(A51_COMMANDS).map((step) => ({ step, outcome: before("console") })) }),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A58",
    behaviour: "aws s3api list-objects-v2 --bucket studio-demo --prefix data/ --delimiter /",
    expect: cells({ minio: one(ok("the objects under data/", { rows: DATA_OBJECTS }), "console") }),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A59",
    behaviour: "aws s3api head-bucket --bucket studio-demo",
    expect: cells({
      minio: one(ok("one Field/Value grid with the members the server sends: none", { rows: 0 }), "console"),
      "minio-region": one(
        ok("one Field/Value grid with the members the server sends: BucketRegion eu-central-1", {
          headers: { BucketRegion: "eu-central-1" },
        }),
        "console",
      ),
      garage: one(ok("one Field/Value grid with the members the server sends: none", { rows: 0 }), "console"),
      rustfs: one(ok("one Field/Value grid with the members the server sends: none", { rows: 0 }), "console"),
    }),
    evidence: ["docs/providers/s3.md", "first live run, 2026-10-10"],
  },
  {
    id: "A60",
    behaviour: "aws s3api get-object-tagging --bucket studio-demo --key meta/tagged.txt",
    expect: cells({
      minio: one(ok("two rows, env probe and tier gold", { rows: 2 }), "console"),
      garage: one(
        refused(server("GetObjectTagging", 501, "NotImplemented", { bucket: "studio-demo", key: "meta/tagged.txt" })),
        "console",
      ),
    }),
    evidence: ["Garage, measured live"],
  },
  {
    id: "A61",
    behaviour: "aws s3api get-bucket-location --bucket studio-demo",
    expect: cells({
      minio: one(
        ok("one row, LocationConstraint us-east-1", {
          headers: { LocationConstraint: "us-east-1" },
        }),
        "console",
      ),
      "minio-region": one(ok("eu-central-1", { headers: { LocationConstraint: "eu-central-1" } }), "console"),
      garage: one(ok("garage", { headers: { LocationConstraint: "garage" } }), "console"),
    }),
    evidence: ["MinIO, measured live", "Garage, measured live", "first live run, 2026-10-10"],
  },
  {
    id: "A62",
    behaviour: "aws s3api get-bucket-versioning --bucket studio-versions",
    expect: cells({
      minio: one(ok("Status Enabled", { headers: { Status: "Enabled" } }), "console"),
      garage: one(
        ok("a grid with no Status, and the note that versioning was never turned on for the bucket", { rows: 0 }),
        "console",
      ),
    }),
    evidence: ["Garage, measured live", "first live run, 2026-10-10"],
  },
  {
    id: "A64",
    behaviour: "aws s3 ls s3://studio-demo/ --endpoint-url http://169.254.169.254/",
    expect: cells({ minio: one(before("console"), "console") }),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A66",
    behaviour: "aws s3api list-objects-v2 --bucket studio-demo --starting-token with a forged token",
    expect: cells({ minio: Object.keys(A66_TOKENS).map((step) => ({ step, outcome: before("console") })) }),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A66b",
    behaviour: "The same command with a well-formed token taken from a studio-bulk listing",
    expect: cells({
      minio: one(
        ok("sent; the server authorises it with the connection's own key and answers the listing's rows: one request", {
          rows: 1,
        }),
        "foreign",
      ),
    }),
    evidence: ["docs/providers/s3.md", "Garage, measured live", "first live run, 2026-10-10"],
  },
  // Read-only, signing and bounds
  {
    id: "A52",
    behaviour: "Every exchange is GET or HEAD; readOnly on and off behave the same",
    expect: cells({
      minio: steps(
        ["wire", ok("holds", { rows: 0 })],
        ["readonly-off", ok("list-buckets answers the same 5 rows", { rows: 5 })],
      ),
    }),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A53",
    behaviour: "Every x-amz header sent is signed",
    expect: cells({ minio: holds }),
    evidence: ["Silo, measured live"],
  },
  {
    id: "A54",
    behaviour: "Every signed request carries x-amz-content-sha256",
    expect: cells({ minio: holds }),
    evidence: ["Garage, measured live"],
  },
  {
    id: "A65",
    behaviour:
      "No provider message, result cell, notice or thrown error of any row holds a fixture secret in any encoding",
    expect: cells({ minio: holds }),
    evidence: ["docs/providers/s3.md"],
  },
  {
    id: "A57",
    behaviour: "Cancel during the 1,000-key listing of A21",
    expect: cells(
      {
        minio: steps(
          ["cancel", ok("the run ends cancelled, no further request", { rows: 0 })],
          ["again", ok("the panel can list again", { pages: [1000], noRepeat: true })],
        ),
      },
      "as-silo",
    ),
    evidence: ["docs/providers/s3.md"],
  },
];

/** The doc's groups, in the order docs/providers/s3.md renders them. */
export const S3_ACCEPTANCE_GROUPS: readonly { readonly title: string; readonly rows: readonly string[] }[] = [
  {
    title: "Connection and Test Connection",
    rows: [
      "A1",
      "A2",
      "A3",
      "A4",
      "A4p",
      "A5",
      "A6",
      "A7",
      "A8",
      "A9",
      "A10",
      "A11",
      "A12",
      "A55",
      "A55b",
      "A63",
      "A56",
    ],
  },
  {
    title: "Listing and the Keys panel",
    rows: [
      "A13",
      "A14",
      "A15",
      "A16",
      "A17",
      "A17b",
      "A18",
      "A19",
      "A20",
      "A21",
      "A22",
      "A23",
      "A23b",
      "A24",
      "A24b",
      "A25",
      "A26",
      "A27",
    ],
  },
  {
    title: "Object metadata and preview",
    rows: [
      "A28",
      "A29",
      "A30",
      "A31",
      "A32",
      "A33",
      "A35",
      "A35b",
      "A36",
      "A37",
      "A38",
      "A39",
      "A40",
      "A41",
      "A42",
      "A45",
    ],
  },
  {
    title: "Console",
    rows: ["A43", "A46", "A47", "A48", "A49", "A50", "A51", "A58", "A59", "A60", "A61", "A62", "A64", "A66", "A66b"],
  },
  { title: "Read-only, signing and bounds", rows: ["A52", "A53", "A54", "A65", "A57"] },
];

// ============================================================================
// The provider's own sentences, and one step's verdict
// ============================================================================

/** What a step ran with, so a sentence is obtained from the provider's code for exactly that input. Never recorded. */
export interface S3SentenceContext {
  readonly connection: DatabaseConnection;
  /** The console command the step ran. */
  readonly command?: string;
  /** The Keys panel options the step passed. */
  readonly scan?: KeyScanOptions;
}

/** The provider's text for a ref, and whether digit runs may differ (a skew sentence's minutes). */
export interface S3ResolvedSentence {
  readonly text?: string;
  readonly pattern?: RegExp;
  readonly anyNumber: boolean;
  /** For `not:<ref>`: the sentence the refusal must differ from. */
  readonly not?: S3ResolvedSentence;
}

const OPERATIONS = new Set([
  "ListBuckets",
  "HeadBucket",
  "GetBucketLocation",
  "GetBucketVersioning",
  "ListObjectsV2",
  "ListObjectVersions",
  "HeadObject",
  "GetObject",
  "GetObjectTagging",
]);

/** The check a ref names accepted the step's input, so the ref names no sentence for that input. */
class S3AcceptedInput extends Error {}

function thrown(run: () => unknown, what: string): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new S3AcceptedInput(`${what} accepted the step's input, so the cell's sentence names no refusal`);
}

/** Matches no message, so `not:` of it matches every refusal. */
const NO_SENTENCE: S3ResolvedSentence = { pattern: /(?!)/, anyNumber: false };

/** A date an hour ahead of now, so a skew answer resolves to the sentence that names the measured minutes. */
const skewedServerDate = () => new Date(Date.now() + 3_600_000).toUTCString();

function connectionOptions(connection: DatabaseConnection) {
  return buildS3ConnectionOptions(connection as Parameters<typeof buildS3ConnectionOptions>[0], {
    executionReadOnly: true,
    queryTimeout: 30_000,
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every problem with a ref that can be found without a step: an unknown form, an unknown notice id or operation. */
export function sentenceRefFinding(ref: string): string | undefined {
  if (ref.startsWith("not:")) return sentenceRefFinding(ref.slice(4));
  if (["connection", "console", "keys"].includes(ref)) return undefined;
  if (/^(egress:link-local|egress:blocked|endpoint:host):\S+$/.test(ref)) return undefined;
  if (ref.startsWith("notice:"))
    return (S3_PREVIEW_SENTENCES as Readonly<Record<string, string>>)[ref.slice(7)] === undefined
      ? `the preview exports no sentence ${ref.slice(7)}`
      : undefined;
  if (ref.startsWith("server:")) {
    try {
      const answer = JSON.parse(ref.slice(7)) as { operation?: string; status?: number };
      if (!OPERATIONS.has(answer.operation ?? "")) return `${ref} names no S3Operation`;
      if (!Number.isInteger(answer.status)) return `${ref} names no status`;
      return undefined;
    } catch {
      return `${ref} is not JSON after server:`;
    }
  }
  return `${ref} is not a sentence ref`;
}

export function resolveS3Sentence(ref: string, context: S3SentenceContext): S3ResolvedSentence {
  if (ref.startsWith("not:")) {
    // An input the named check accepts has no such sentence, so every refusal differs from it.
    try {
      return { anyNumber: false, not: resolveS3Sentence(ref.slice(4), context) };
    } catch (error) {
      if (error instanceof S3AcceptedInput) return { anyNumber: false, not: NO_SENTENCE };
      throw error;
    }
  }
  if (ref === "connection")
    return { text: thrown(() => connectionOptions(context.connection), "buildS3ConnectionOptions"), anyNumber: false };
  if (ref === "console") {
    const options = connectionOptions(context.connection);
    const parsed = parseS3Command(context.command ?? "", {
      endpoint: s3EndpointText(options),
      region: options.region,
      ...(options.pinnedBucket === undefined ? {} : { pinnedBucket: options.pinnedBucket }),
      readOnly: true,
    });
    if (parsed.ok)
      throw new Error(
        `the console accepts ${JSON.stringify(context.command)}, so the cell's sentence names no refusal`,
      );
    return { text: parsed.refusal.message, anyNumber: false };
  }
  if (ref === "keys")
    return {
      text: thrown(
        () => readS3KeyScanRequest(context.scan as KeyScanOptions, context.connection.database || undefined),
        "readS3KeyScanRequest",
      ),
      anyNumber: false,
    };
  if (ref.startsWith("egress:link-local:"))
    return {
      text: thrown(() => assertNotLinkLocalLiteral(ref.slice(18)), "assertNotLinkLocalLiteral"),
      anyNumber: false,
    };
  if (ref.startsWith("endpoint:host:"))
    return { text: thrown(() => validateHost(ref.slice(14)), "validateHost"), anyNumber: false };
  if (ref.startsWith("egress:blocked:")) {
    const previous = process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
    process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = "true";
    try {
      return {
        text: thrown(() => assertPublicLiteralHost(ref.slice(15)), "assertPublicLiteralHost"),
        anyNumber: false,
      };
    } finally {
      if (previous === undefined) delete process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
      else process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = previous;
    }
  }
  if (ref.startsWith("notice:")) {
    const template = (S3_PREVIEW_SENTENCES as Readonly<Record<string, string>>)[ref.slice(7)];
    if (template === undefined) throw new Error(`the preview exports no sentence ${ref.slice(7)}`);
    return {
      pattern: new RegExp(
        `^${template
          .split(/\{[a-zA-Z]+\}/)
          .map(escapeRegExp)
          .join(".+?")}$`,
      ),
      anyNumber: false,
    };
  }
  if (ref.startsWith("server:")) {
    const answer = JSON.parse(ref.slice(7)) as {
      operation: Parameters<typeof toProviderError>[1];
      status: number;
      code?: string;
      message?: string;
      region?: string;
      bucket?: string;
      key?: string;
      method?: "GET" | "HEAD";
      sentToken?: boolean;
      anyNumber?: true;
    };
    const options = connectionOptions(context.connection);
    const error = new S3ServerError({
      operation: answer.operation,
      method: answer.method ?? (answer.operation.startsWith("Head") ? "HEAD" : "GET"),
      status: answer.status,
      ...(answer.code === undefined ? {} : { code: answer.code }),
      ...(answer.message === undefined ? {} : { message: answer.message }),
      ...(answer.region === undefined ? {} : { region: answer.region }),
      ...(answer.bucket === undefined ? {} : { bucket: answer.bucket }),
      ...(answer.key === undefined ? {} : { key: answer.key }),
      ...(answer.sentToken === undefined ? {} : { sentToken: answer.sentToken }),
      ...(answer.anyNumber === true ? { serverDate: skewedServerDate() } : {}),
    });
    const mapped = toProviderError(error, answer.operation, {
      region: options.region,
      signs: options.credentials !== null,
      clock: () => new Date(),
      secretForms: options.secretForms,
      endpointText: s3EndpointText(options),
    }) as Error;
    return { text: mapped.message, anyNumber: answer.anyNumber === true };
  }
  throw new Error(`${ref} is not a sentence ref`);
}

/** What a runner observed in one step, as a capture's result records it. */
export interface S3Observed {
  readonly rows?: number;
  readonly names?: readonly string[];
  readonly pages?: readonly number[];
  readonly repeats?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly notices?: readonly string[];
}

export interface S3StepSummary {
  readonly step: string;
  /** Present when the step ran to an answer. */
  readonly ok?: S3Observed;
  /** The refusal's message, request ids dropped (normalizeMessage), when the step was refused. */
  readonly refused?: string;
  /** Requests the step sent. */
  readonly exchanges: number;
}

const digits = (text: string) => text.replace(/\d+/g, "#");

function sentenceMatches(message: string, resolved: S3ResolvedSentence): boolean {
  if (resolved.not !== undefined) return !sentenceMatches(message, resolved.not);
  if (resolved.pattern !== undefined) return resolved.pattern.test(message);
  return resolved.anyNumber ? digits(message) === digits(resolved.text ?? "") : message === resolved.text;
}

/** Whether `wanted` appears in `observed` in the same relative order. */
function inOrder(observed: readonly string[], wanted: readonly string[]): boolean {
  let at = 0;
  for (const name of observed) if (name === wanted[at]) at++;
  return at === wanted.length;
}

function checkFailure(check: S3Check, seen: S3Observed, context: S3SentenceContext): string | undefined {
  if ("exchanges" in check) return undefined;
  if ("pages" in check)
    return JSON.stringify(seen.pages) === JSON.stringify(check.pages) && (seen.repeats ?? 0) === 0
      ? undefined
      : `pages ${JSON.stringify(seen.pages)} with ${seen.repeats ?? 0} repeat(s), expected ${JSON.stringify(check.pages)} with none`;
  if ("notice" in check) {
    const resolved = resolveS3Sentence(check.notice, context);
    if (!(seen.notices ?? []).some((notice) => sentenceMatches(notice, resolved)))
      return `no notice matching ${check.notice} among ${JSON.stringify(seen.notices ?? [])}`;
    if (check.rows !== undefined && seen.rows !== check.rows) return `${seen.rows} rows, expected ${check.rows}`;
    if (check.names !== undefined && JSON.stringify(seen.names ?? []) !== JSON.stringify(check.names))
      return `names ${JSON.stringify(seen.names ?? [])}, expected exactly ${JSON.stringify(check.names)}`;
    return undefined;
  }
  if ("names" in check)
    return inOrder(seen.names ?? [], check.names)
      ? undefined
      : `names ${JSON.stringify(seen.names)} do not hold ${JSON.stringify(check.names)} in order`;
  if ("headers" in check) {
    const wrong = Object.entries(check.headers).filter(([name, value]) => (seen.headers ?? {})[name] !== value);
    return wrong.length === 0
      ? undefined
      : wrong
          .map(
            ([name, value]) =>
              `${name} is ${JSON.stringify((seen.headers ?? {})[name] ?? null)}, expected ${JSON.stringify(value)}`,
          )
          .join("; ");
  }
  return seen.rows === check.rows ? undefined : `${seen.rows} rows, expected ${check.rows}`;
}

/**
 * The verdict of one step: undefined when the summary is what the expectation says, else why not. `sockets` is the
 * number of sockets the step opened, known on a live run only; the replay passes 0.
 */
export function checkS3Step(
  expectation: S3Expectation,
  summary: S3StepSummary,
  context: S3SentenceContext,
  sockets: number,
): string | undefined {
  switch (expectation.kind) {
    case "not-applicable":
      return `${summary.step} ran, but the cell is not applicable: ${expectation.why}`;
    case "ok":
      if (summary.refused !== undefined) return `refused: ${summary.refused}`;
      if ("exchanges" in expectation.check && summary.exchanges !== 0)
        return `${summary.exchanges} request(s) sent, expected none`;
      return checkFailure(expectation.check, summary.ok ?? {}, context);
    case "refused":
    case "refused-before-request": {
      if (summary.refused === undefined) return `answered ${JSON.stringify(summary.ok)}, expected a refusal`;
      if (!sentenceMatches(summary.refused, resolveS3Sentence(expectation.sentence, context)))
        return `refused with ${JSON.stringify(summary.refused)}, which is not ${expectation.sentence}`;
      if (expectation.kind === "refused") {
        const missing = (expectation.names ?? []).filter((name) => !summary.refused?.includes(name));
        return missing.length === 0 ? undefined : `the refusal does not name ${missing.join(", ")}`;
      }
      return summary.exchanges === 0 && sockets === 0
        ? undefined
        : `${summary.exchanges} request(s) and ${sockets} socket(s) before the refusal, expected none`;
    }
  }
}

// ============================================================================
// The matrix as the provider doc renders it
// ============================================================================

function describeRef(ref: string): string {
  if (ref.startsWith("not:")) return `an error other than ${describeRef(ref.slice(4))}`;
  if (ref === "connection") return "the connection check's sentence";
  if (ref === "console") return "the console's refusal sentence";
  if (ref === "keys") return "the Keys panel's cursor sentence";
  if (ref.startsWith("egress:link-local:")) return `the link-local sentence for ${ref.slice(18)}`;
  if (ref.startsWith("egress:blocked:")) return "the DB_HTTP_BLOCK_PRIVATE_HOSTS sentence";
  if (ref.startsWith("endpoint:host:")) return "the shared invalid-host sentence";
  if (ref.startsWith("notice:")) return `notice ${ref.slice(7)}`;
  const answer = JSON.parse(ref.slice(7)) as { operation: string; status: number; code?: string; message?: string };
  return `the sentence for ${answer.status}${answer.code === undefined ? "" : ` ${answer.code}`}${answer.message === undefined ? "" : ` "${answer.message}"`} to ${answer.operation}`;
}

function cellText(cell: readonly S3Step[]): string {
  const texts = cell.map(({ step, outcome }) => {
    const text =
      outcome.kind === "ok"
        ? outcome.detail
        : outcome.kind === "not-applicable"
          ? `not applicable: ${outcome.why}`
          : outcome.kind === "refused"
            ? `refused, ${describeRef(outcome.sentence)}${outcome.names === undefined ? "" : ` naming ${outcome.names.join(", ")}`}`
            : `refused before any request, ${describeRef(outcome.sentence)}`;
    return cell.length === 1 ? text : `${step}: ${text}`;
  });
  return texts.join("; ").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** The Markdown block between docs/providers/s3.md's s3-acceptance markers. */
export function renderS3Acceptance(): string {
  const byId = new Map(S3_ACCEPTANCE.map((row) => [row.id, row]));
  const lines: string[] = [];
  for (const group of S3_ACCEPTANCE_GROUPS) {
    lines.push(
      `**${group.title}**`,
      "",
      `| Row | Behaviour | ${S3_MATRIX_COLUMNS.map((target) => S3_TARGETS[target].label).join(" | ")} |`,
      `|---|---|${S3_MATRIX_COLUMNS.map(() => "---|").join("")}`,
    );
    for (const id of group.rows) {
      const row = byId.get(id as S3AcceptanceRow["id"]);
      if (row === undefined) throw new Error(`S3_ACCEPTANCE_GROUPS names ${id}, which S3_ACCEPTANCE does not hold`);
      lines.push(
        `| ${row.id} | ${row.behaviour.replace(/\|/g, "\\|")} | ${S3_MATRIX_COLUMNS.map((target) => cellText(row.expect[target])).join(" | ")} |`,
      );
    }
    lines.push("");
  }
  lines.push("`silo-tls` runs A1, A2, A14, A37 and A57, each as on Silo; A63 runs only in the SSH tunnel check.");
  return lines.join("\n");
}

// ============================================================================
// The runners: one function per step of each row, shared by the live check, the harness and the replay
// ============================================================================

export interface S3RunContext {
  readonly target: S3Target;
  readonly principals: S3Principals;
  /** The TLS fixture's CA as PEM text, for silo-tls. */
  readonly ca?: string;
  /** The factory every provider of the run is built with: the production one wrapped by a recorder, or a replay. */
  readonly createTransport: S3TransportFactory;
  /** The clock a provider of the run gets for a scenario offset; a replay ignores the offset, which its recording holds. */
  readonly clockFor: (offsetMs: number) => () => Date;
  readonly signerWrapper: (signer: RequestSigner) => RequestSigner;
  /** Names the step the next requests belong to. */
  readonly setStep: (step: string) => void;
  /** Sockets opened so far; the replay answers 0. */
  readonly sockets: () => number;
  /** Every signed request of the run so far, as a capture records it (the wire rows read it). */
  readonly recorded: () => readonly S3RecordedRequest[];
  /** Live runs only: what rows A9, A56 and A65 need from the process. */
  readonly live?: {
    readonly nonLoopbackIPv4: string;
    /** Sets every ambient AWS credential source and returns its undo. */
    readonly setAmbientCredentials: () => () => void;
    readonly canaryConnections: () => number;
    readonly secretHits: () => number;
  };
  /** The tunnel check only: the bastion row A63 dials through. */
  readonly tunnel?: {
    readonly sshTunnel: NonNullable<DatabaseConnection["sshTunnel"]>;
    readonly open: (connection: DatabaseConnection) => Promise<DatabaseProvider>;
  };
}

export interface S3StepRun {
  readonly summary: S3StepSummary;
  readonly context: S3SentenceContext;
  readonly sockets: number;
  /** A refused step's cause chain, outermost first, unmasked: row A65 searches it; the captures never hold it. */
  readonly causes?: readonly string[];
}

/** How deep a refusal's cause chain is followed, so a cause that points back at itself still ends. */
const CAUSE_DEPTH = 8;

function causeChain(error: unknown): string[] {
  const causes: string[] = [];
  let cause = error instanceof Error ? error.cause : undefined;
  while (cause !== undefined && causes.length < CAUSE_DEPTH) {
    causes.push(cause instanceof Error ? cause.message : String(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return causes;
}

/** What row A65 searches in one step: its refusal, every message of that refusal's cause chain, and its answer. */
export function s3SecretMaterial(stepRun: S3StepRun): string[] {
  const { summary } = stepRun;
  return [
    ...(summary.refused === undefined ? [] : [summary.refused]),
    ...(stepRun.causes ?? []),
    ...(summary.ok === undefined ? [] : [JSON.stringify(summary.ok)]),
  ];
}

interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
  status?: number;
}

/** The requests one row run sent, as the provider asked for them, with each answer's status. */
interface Wire {
  readonly createTransport: S3TransportFactory;
  readonly seen: SeenRequest[];
  signs: number;
}

function observe(factory: S3TransportFactory): Wire {
  const wire: Wire = {
    seen: [],
    signs: 0,
    createTransport: (options: NodeByteTransportOptions) => {
      const inner = factory(options);
      return {
        async request(request) {
          const entry: SeenRequest = {
            method: request.method,
            path: request.target.path,
            query: request.target.query,
            headers: { ...(request.headers ?? {}) },
          };
          wire.seen.push(entry);
          const response = await inner.request(request);
          entry.status = response.status;
          return response;
        },
        close: () => inner.close(),
      };
    },
  };
  return wire;
}

type S3StepFunction = (run: S3RunContext, wire: Wire) => Promise<S3StepRun>;

function provider(run: S3RunContext, wire: Wire, connection: DatabaseConnection, offsetMs = 0): S3Provider {
  return new S3Provider(
    connection,
    {},
    {},
    {
      createTransport: wire.createTransport,
      clock: run.clockFor(offsetMs),
      signerWrapper: (signer) => {
        const wrapped = run.signerWrapper(signer);
        return {
          headerNames: wrapped.headerNames,
          sign(input) {
            wire.signs++;
            return wrapped.sign(input);
          },
        };
      },
    },
  );
}

/** Runs one step: its answer, or its refusal's message as a summary records it. */
async function step(
  run: S3RunContext,
  wire: Wire,
  name: string,
  context: S3SentenceContext,
  body: () => Promise<S3Observed>,
): Promise<S3StepRun> {
  run.setStep(name);
  const requests = wire.seen.length;
  const sockets = run.sockets();
  let summary: S3StepSummary;
  let causes: string[] = [];
  try {
    const ok = await body();
    summary = { step: name, ok, exchanges: wire.seen.length - requests };
  } catch (error) {
    summary = {
      step: name,
      refused: normalizeMessage(error instanceof Error ? error.message : String(error)),
      exchanges: wire.seen.length - requests,
    };
    causes = causeChain(error);
  }
  return { summary, context, sockets: run.sockets() - sockets, ...(causes.length === 0 ? {} : { causes }) };
}

/** One step on a wire of its own, outside any row. */
export function runS3Step(
  run: S3RunContext,
  name: string,
  context: S3SentenceContext,
  body: () => Promise<S3Observed>,
): Promise<S3StepRun> {
  return step(run, observe(run.createTransport), name, context, body);
}

const connectionOf = (run: S3RunContext, plan: S3ConnectionPlan) =>
  s3LiveConnection(run.target, run.principals, plan, run.ca);

async function withProvider<T>(p: S3Provider, body: (p: S3Provider) => Promise<T>): Promise<T> {
  try {
    await p.connect();
    return await body(p);
  } finally {
    await p.disconnect();
  }
}

/**
 * Runs a step on a provider connected before the step's count starts, so a refusal the console or the Keys route
 * gives before any request counts no exchange, while the session's own connect probe is not the step's. A connect
 * that fails becomes the step's refusal.
 */
async function onConnected(
  run: S3RunContext,
  wire: Wire,
  name: string,
  context: S3SentenceContext,
  body: (p: S3Provider) => Promise<S3Observed>,
): Promise<S3StepRun> {
  const p = provider(run, wire, context.connection);
  run.setStep(name);
  let failure: unknown;
  try {
    await p.connect();
  } catch (error) {
    failure = error;
  }
  try {
    return await step(run, wire, name, context, async () => {
      if (failure !== undefined) throw failure;
      return body(p);
    });
  } finally {
    await p.disconnect();
  }
}

/** POST /api/db/test-connection's calls (connect, then getHealth), then the bucket count the sidebar would show. */
async function testConnection(p: S3Provider): Promise<S3Observed> {
  return withProvider(p, async () => {
    await p.getHealth();
    return { rows: (await p.listObjects([], "bucket")).length };
  });
}

async function bucketNames(p: S3Provider): Promise<S3Observed> {
  return withProvider(p, async () => {
    const names = (await p.listObjects([], "bucket")).map((object) => object.name);
    return { rows: names.length, names };
  });
}

/**
 * The keys route's checks on one level page, which the route keeps private, so a page the route would answer with a
 * 500 fails the live check and the replay too: keys and prefixes together fit in count, every prefix ends at the
 * first "/" after the pattern, every key sits directly under the pattern and is not empty, nothing is listed twice.
 */
export function levelPageDefect(
  pattern: string,
  count: number,
  page: Pick<KeyScanPage, "keys" | "prefixes">,
): string | undefined {
  const prefixes = page.prefixes ?? [];
  const entries = prefixes.length + page.keys.length;
  if (entries > count) return `the level page holds ${entries} entries, more than its count of ${count}`;
  const seen = new Set<string>();
  for (const prefix of prefixes) {
    const first = prefix.indexOf("/", pattern.length);
    if (!prefix.startsWith(pattern) || first === -1 || first !== prefix.length - 1)
      return `the level page holds the folder ${JSON.stringify(prefix)}, which is outside the level of ${JSON.stringify(pattern)}`;
    if (seen.has(prefix)) return `the level page holds ${JSON.stringify(prefix)} twice`;
    seen.add(prefix);
  }
  for (const key of page.keys) {
    if (key === "" || !key.startsWith(pattern) || key.slice(pattern.length).includes("/"))
      return `the level page holds the key ${JSON.stringify(key)}, which is outside the level of ${JSON.stringify(pattern)}`;
    if (seen.has(key)) return `the level page holds ${JSON.stringify(key)} twice`;
    seen.add(key);
  }
  return undefined;
}

/** A Keys panel walk of one level, page after page, as the panel's Load more asks for it. */
async function walk(
  p: S3Provider,
  pattern: string,
  maxPages = 20,
  count = 1000,
): Promise<S3Observed & { cursor: string }> {
  const names: string[] = [];
  const pages: number[] = [];
  const headers: Record<string, string> = {};
  let cursor = "0";
  do {
    const page = await p.scanKeysPage!({ cursor, pattern, count, level: true });
    const defect = levelPageDefect(pattern, count, page);
    if (defect !== undefined) throw new Error(defect);
    const entries = [...(page.prefixes ?? []), ...page.keys];
    names.push(...entries);
    pages.push(entries.length);
    Object.assign(headers, page.types ?? {});
    cursor = page.cursor;
  } while (cursor !== "0" && pages.length < maxPages);
  return { names, pages, repeats: names.length - new Set(names).size, headers, rows: names.length, cursor };
}

function valueText(value: unknown): string {
  return value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** A console command's answer: its rows, its columns or Field/Value grid, and its warnings. */
async function consoleRun(p: S3Provider, command: string, queryId?: string): Promise<S3Observed> {
  const result = await p.query(command, [], queryId);
  const grid = result.fields.length === 2 && result.fields[0] === "Field" && result.fields[1] === "Value";
  return {
    rows: result.rowCount,
    names: grid ? result.rows.map((row) => valueText(row.Field)) : result.fields,
    ...(grid
      ? { headers: Object.fromEntries(result.rows.map((row) => [valueText(row.Field), valueText(row.Value)])) }
      : {}),
    notices: (result.warnings ?? []).map((warning) => warning.message),
  };
}

function flatten(json: Record<string, unknown>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(json)) {
    if (name === "user_metadata" && value !== null && typeof value === "object")
      for (const [meta, values] of Object.entries(value as Record<string, unknown>))
        flat[`user_metadata.${meta}`] = Array.isArray(values) ? values.join(",") : valueText(values);
    else if (name === "tags" && value !== null && typeof value === "object")
      flat.tags = Object.entries(value as Record<string, string>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([tag, tagValue]) => `${tag}=${tagValue}`)
        .join("&");
    else flat[name] = value === null ? "null" : valueText(value);
  }
  return flat;
}

/** The Source tab of one object: the metadata part's fields, the preview part's form, the preview notes. */
async function source(p: S3Provider, wire: Wire, bucket: string, key: string): Promise<S3Observed> {
  return withProvider(p, async () => {
    const before = wire.seen.length;
    const document = await p.readObjectSource!([joinVirtualKey(bucket, key)], "object");
    const part = (id: string) => document.parts.find((candidate) => candidate.id === id);
    const metadata = part("metadata");
    if (metadata === undefined || "unavailable" in metadata)
      throw new Error(metadata === undefined ? "no metadata part" : metadata.unavailable);
    const headers = flatten(JSON.parse(metadata.text) as Record<string, unknown>);
    const preview = part("preview");
    if (preview !== undefined) {
      headers.preview = "unavailable" in preview ? "unavailable" : preview.text.trim().slice(0, 64);
      if (!("unavailable" in preview)) {
        headers["preview-origin"] = preview.origin;
        headers["preview-language"] = preview.language;
      }
    }
    const gets = wire.seen
      .slice(before)
      .filter((request) => request.method === "GET" && request.headers.range !== undefined);
    const ranged = gets.find((request) => request.headers.range.startsWith("bytes=0-"));
    const suffix = gets.find((request) => request.headers.range.startsWith("bytes=-"));
    if (ranged?.status !== undefined) headers["range-status"] = String(ranged.status);
    if (suffix?.status !== undefined) headers["suffix-status"] = String(suffix.status);
    const notes = part("preview-notes");
    return {
      headers,
      notices:
        notes !== undefined && !("unavailable" in notes) ? notes.text.split("\n").filter((line) => line !== "") : [],
    };
  });
}

function queryValue(query: string, name: string): string | undefined {
  const pair = query.split("&").find((candidate) => candidate === name || candidate.startsWith(`${name}=`));
  return pair === undefined ? undefined : pair.slice(name.length + 1);
}

/** A step of a Test Connection on a plan. */
const testStep =
  (name: string, plan: S3ConnectionPlan, offsetMs = 0): S3StepFunction =>
  (run, wire) => {
    const connection = connectionOf(run, plan);
    return step(run, wire, name, { connection }, () => testConnection(provider(run, wire, connection, offsetMs)));
  };

/** A step of one console command as root on studio-demo's connection. */
const consoleStep =
  (name: string, command: string, plan: S3ConnectionPlan = { role: "root" }): S3StepFunction =>
  (run, wire) => {
    const connection = connectionOf(run, plan);
    return onConnected(run, wire, name, { connection, command }, (p) => consoleRun(p, command));
  };

const previewStep = (name: string, key: string): S3StepFunction => consoleStep(name, `preview s3://studio-demo/${key}`);

/** A step of a Keys panel walk of one level as root. */
const walkStep =
  (name: string, pattern: string, plan: S3ConnectionPlan = { role: "root" }, maxPages = 20): S3StepFunction =>
  (run, wire) => {
    const connection = connectionOf(run, plan);
    const scan = { cursor: "0", pattern, count: 1000, level: true } as const;
    return step(run, wire, name, { connection, scan }, () =>
      withProvider(provider(run, wire, connection), (p) => walk(p, pattern, maxPages)),
    );
  };

const sourceStep =
  (name: string, key: string): S3StepFunction =>
  (run, wire) => {
    const connection = connectionOf(run, { role: "root" });
    return step(run, wire, name, { connection }, () =>
      source(provider(run, wire, connection), wire, "studio-demo", key),
    );
  };

/** The rows that are rules over every request a run sent, each answering the requests that break it. */
export function wireViolations(
  row: "A26" | "A27" | "A33" | "A45" | "A52" | "A53" | "A54",
  requests: readonly S3RecordedRequest[],
): string[] {
  const at = (request: S3RecordedRequest) =>
    `${request.method} ${request.path}${request.query === "" ? "" : `?${request.query}`}`;
  return requests
    .filter((request) => {
      const names = request.query === "" ? [] : request.query.split("&").map((pair) => pair.split("=")[0]);
      switch (row) {
        case "A26": {
          const maxKeys = queryValue(request.query, "max-keys");
          return maxKeys !== undefined && (Number(maxKeys) < 1 || Number(maxKeys) > 1000);
        }
        case "A27":
          return names.includes("start-after");
        case "A33":
          return (request.headers.range ?? "").includes(",");
        case "A45":
          return names.includes("attributes");
        case "A52":
          return request.method !== "GET" && request.method !== "HEAD";
        case "A53":
          return (
            request.authorization !== null &&
            Object.keys(request.headers).some(
              (name) => name.startsWith("x-amz-") && !request.authorization?.signedHeaders.includes(name),
            )
          );
        case "A54":
          return request.authorization !== null && request.headers["x-amz-content-sha256"] === undefined;
      }
    })
    .map(at);
}

const wireStep =
  (row: Parameters<typeof wireViolations>[0], name = "run"): S3StepFunction =>
  (run, wire) => {
    const connection = connectionOf(run, { role: "root" });
    return step(run, wire, name, { connection }, async () => ({ rows: wireViolations(row, run.recorded()).length }));
  };

const DOT_ENTRIES = new Set([
  "studio-demo/sp/./",
  "studio-demo/sp/double/",
  "studio-demo/sp/x/",
  ...[...DOT_KEYS].map((key) => `studio-demo/${key}`),
]);

/** The server's continuation token inside a Keys panel cursor, written s3c:1:<base64url JSON> with the token under "t". */
function serverToken(cursor: string): string {
  const payload = JSON.parse(Buffer.from(cursor.slice("s3c:1:".length), "base64url").toString("utf8")) as {
    t?: string;
  };
  if (payload.t === undefined) throw new Error("the cursor holds no server token");
  return payload.t;
}

function withEnv<T>(name: string, value: string | undefined, body: () => Promise<T>): Promise<T> {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return body().finally(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

const needsLive = (row: string) => {
  throw new Error(`${row} runs only in tests/live/s3-live-check.ts, which gives the run its live context`);
};

function linkLocalSteps(): Record<string, S3StepFunction> {
  const steps: Record<string, S3StepFunction> = {};
  // Connect without TLS is ticked, so the plain-HTTP consent check passes and the link-local check is what
  // refuses: no consent unlocks a link-local origin.
  for (const host of LINK_LOCAL_HOSTS)
    for (const setting of ["unset", "false"] as const)
      steps[`${host} ${setting}`] = (run, wire) =>
        withEnv("DB_HTTP_BLOCK_PRIVATE_HOSTS", setting === "unset" ? undefined : "false", () =>
          testStep(`${host} ${setting}`, { role: "root", host, allowInsecureAuth: true })(run, wire),
        );
  for (const host of NUMERIC_HOSTS) steps[host] = testStep(host, { role: "root", host });
  return steps;
}

function commandSteps(commands: Readonly<Record<string, string>>): Record<string, S3StepFunction> {
  return Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, consoleStep(name, command)]));
}

/** Every step of every row, by row id and step name. A row's steps run in the order its cell lists them. */
export const S3_RUNNERS: Readonly<Record<string, Readonly<Record<string, S3StepFunction>>>> = {
  A1: { test: testStep("test", { role: "root" }) },
  A2: {
    test: (run, wire) => {
      const connection = connectionOf(run, { role: "root", pin: "studio-demo" });
      return step(run, wire, "test", { connection }, async () => {
        const before = wire.seen.length;
        await testConnection(provider(run, wire, connection));
        const sent = wire.seen.slice(before);
        const first = sent[0];
        const value = (name: string) => decodeURIComponent(queryValue(first?.query ?? "", name) ?? "");
        return {
          headers: {
            requests: String(sent.length),
            method: [...new Set(sent.map((request) => request.method))].join(","),
            "same probe": sent.every((request) => request.path === first?.path && request.query === first?.query)
              ? "yes"
              : "no",
            "max-keys": value("max-keys"),
            delimiter: value("delimiter"),
            "encoding-type": value("encoding-type"),
          },
        };
      });
    },
  },
  A3: { test: testStep("test", { role: "root", pin: "no-such-bucket" }) },
  A4: { test: testStep("test", { role: "root", secret: "wrong-secret-for-row-a4" }) },
  A4p: { test: testStep("test", { role: "root", pin: "studio-demo", secret: "wrong-secret-for-row-a4" }) },
  A5: { test: testStep("test", { role: "root", accessKeyId: "GKffffffffffffffffffffffff" }) },
  A6: { browse: walkStep("browse", "studio-demo/", { role: "root", region: "us-east-1" }, 1) },
  A7: { browse: walkStep("browse", "studio-demo/", { role: "root", region: "not-a-region" }, 1) },
  A8: {
    ahead: testStep("ahead", { role: "root" }, 1_200_000),
    behind: testStep("behind", { role: "root" }, -90_000_000),
  },
  A9: {
    anonymous: (run, wire) => {
      if (run.live === undefined) return needsLive("A9");
      const undo = run.live.setAmbientCredentials();
      return testStep("anonymous", { role: "root", anonymous: true })(run, wire).finally(undo);
    },
    unsigned: (run, wire) => {
      if (run.live === undefined) return needsLive("A9");
      const live = run.live;
      const connection = connectionOf(run, { role: "root", anonymous: true });
      return step(run, wire, "unsigned", { connection }, async () => ({
        headers: {
          authorization: wire.signs === 0 ? "absent" : "present",
          "x-amz-headers": String(
            wire.seen.reduce(
              (count, request) =>
                count + Object.keys(request.headers).filter((name) => name.startsWith("x-amz-")).length,
              0,
            ),
          ),
          canary: String(live.canaryConnections()),
        },
      }));
    },
  },
  A10: {
    "studio-demo": testStep("studio-demo", { role: "scoped", pin: "studio-demo" }),
    "no-such-bucket": testStep("no-such-bucket", { role: "scoped", pin: "no-such-bucket" }),
  },
  A11: {
    list: (run, wire) => {
      const connection = connectionOf(run, { role: "getonly" });
      return step(run, wire, "list", { connection }, () => bucketNames(provider(run, wire, connection)));
    },
    open: walkStep("open", "studio-demo/", { role: "getonly" }, 1),
    head: consoleStep("head", "aws s3api head-object --bucket studio-demo --key data/table.csv", { role: "getonly" }),
    pinned: testStep("pinned", { role: "getonly", pin: "studio-demo" }),
  },
  A12: {
    scoped: (run, wire) => {
      const connection = connectionOf(run, { role: "scoped" });
      return step(run, wire, "scoped", { connection }, () => bucketNames(provider(run, wire, connection)));
    },
    none: (run, wire) => {
      const connection = connectionOf(run, { role: "getonly" });
      return step(run, wire, "none", { connection }, () => bucketNames(provider(run, wire, connection)));
    },
  },
  A55: linkLocalSteps(),
  A55b: {
    blocked: (run, wire) =>
      withEnv("DB_HTTP_BLOCK_PRIVATE_HOSTS", "true", () => testStep("blocked", { role: "root" })(run, wire)),
  },
  A63: {
    plain: (run, wire) => tunnelStep(run, wire, "plain", "silo", 9000, false),
    tls: (run, wire) => tunnelStep(run, wire, "tls", "silo-tls", 9000, true),
    "link-local": (run, wire) => tunnelStep(run, wire, "link-local", "169.254.169.254", 9000, false),
  },
  A56: {
    "no-consent": (run, wire) =>
      run.live === undefined
        ? needsLive("A56")
        : testStep("no-consent", { role: "root", host: run.live.nonLoopbackIPv4 })(run, wire),
    consent: (run, wire) =>
      run.live === undefined
        ? needsLive("A56")
        : testStep("consent", { role: "root", host: run.live.nonLoopbackIPv4, allowInsecureAuth: true })(run, wire),
  },
  A13: {
    list: (run, wire) => {
      const connection = connectionOf(run, { role: "root" });
      return step(run, wire, "list", { connection }, () => bucketNames(provider(run, wire, connection)));
    },
  },
  A14: { level: walkStep("level", "studio-demo/") },
  A15: { level: walkStep("level", "studio-demo/dir/") },
  A16: { level: walkStep("level", "studio-demo/keys/dirmarker/"), open: sourceStep("open", "keys/dirmarker/") },
  A17: {
    list: walkStep("list", "studio-demo/sp/"),
    open: (run, wire) => {
      const connection = connectionOf(run, { role: "root" });
      const keys = storedSpecialKeys(S3_TARGETS[run.target].server, "all").map((name) =>
        name.slice("studio-demo/".length),
      );
      return step(run, wire, "open", { connection }, async () => {
        for (const key of keys) await source(provider(run, wire, connection), wire, "studio-demo", key);
        return { rows: keys.length };
      });
    },
  },
  A17b: {
    keys: walkStep("keys", "studio-demo/sp/with space"),
    console: (run, wire) => {
      const command = "aws s3api list-objects-v2 --bucket studio-demo --prefix 'sp/*'";
      const connection = connectionOf(run, { role: "root" });
      return step(run, wire, "console", { connection, command }, async () => {
        const before = wire.seen.length;
        await withProvider(provider(run, wire, connection), (p) => consoleRun(p, command));
        // The listing, not the connect probe that precedes it.
        const listing = wire.seen.slice(before).find((request) => queryValue(request.query, "list-type") === "2");
        return { headers: { prefix: queryValue(listing?.query ?? "", "prefix") ?? "" } };
      });
    },
  },
  A18: {
    tab: (run, wire) => {
      const connection = connectionOf(run, { role: "root" });
      return step(run, wire, "tab", { connection }, async () => {
        const listed = await withProvider(provider(run, wire, connection), (p) => walk(p, "studio-demo/sp/"));
        await source(provider(run, wire, connection), wire, "studio-demo", "sp/tab\tchar.txt");
        return { names: listed.names };
      });
    },
    control: (run, wire) => {
      const connection = connectionOf(run, { role: "root" });
      return step(run, wire, "control", { connection }, async () => {
        const listed = await withProvider(provider(run, wire, connection), (p) => walk(p, "studio-demo/ctl/"));
        await source(provider(run, wire, connection), wire, "studio-demo", "ctl/x\u0001y.txt");
        return { names: listed.names };
      });
    },
  },
  A19: {
    list: (run, wire) => {
      const connection = connectionOf(run, { role: "root" });
      return step(run, wire, "list", { connection }, async () => {
        const listed = await withProvider(provider(run, wire, connection), (p) => walk(p, "studio-demo/sp/"));
        return { rows: (listed.names ?? []).filter((name) => DOT_ENTRIES.has(name)).length };
      });
    },
    open: (run, wire) => {
      const connection = connectionOf(run, { role: "root" });
      const keys = storedDotKeys(S3_TARGETS[run.target].server);
      return step(run, wire, "open", { connection }, async () => {
        for (const key of keys) await source(provider(run, wire, connection), wire, "studio-demo", key);
        return { rows: keys.length };
      });
    },
  },
  A20: { head: consoleStep("head", "aws s3api head-object --bucket studio-demo --key /x") },
  A21: { level: walkStep("level", "studio-bulk/many/") },
  A22: { level: walkStep("level", "studio-bulk/folders/") },
  A23: { level: walkStep("level", "studio-bulk/mixed/") },
  A23b: {
    level: walkStep("level", "studio-versions/ver/"),
    deleted: (run, wire) => {
      const connection = connectionOf(run, { role: "root" });
      return step(run, wire, "deleted", { connection }, async () => {
        const listed = await withProvider(provider(run, wire, connection), (p) => walk(p, "studio-versions/ver/"));
        return { rows: (listed.names ?? []).filter((name) => name === "studio-versions/ver/deleted.txt").length };
      });
    },
  },
  A24: Object.fromEntries(
    (
      [
        ["spelling", "s3c:2:abc"],
        ["long", `s3c:1:${"A".repeat(16_385)}`],
        ["shape", `s3c:1:${Buffer.from(JSON.stringify({ x: 1 })).toString("base64url")}`],
      ] as const
    ).map(([name, cursor]): [string, S3StepFunction] => [
      name,
      (run, wire) => {
        const connection = connectionOf(run, { role: "root" });
        const scan = { cursor, pattern: "studio-bulk/many/", count: 1000, level: true } as const;
        return onConnected(run, wire, name, { connection, scan }, async (p) => ({
          rows: (await p.scanKeysPage!(scan)).keys.length,
        }));
      },
    ]),
  ),
  A24b: {
    handover: (run, wire) => {
      const connection = connectionOf(run, { role: "root" });
      const level = { pattern: "studio-bulk/folders/", count: 1000 } as const;
      return step(run, wire, "handover", { connection }, async () => {
        const first = await withProvider(provider(run, wire, connection), (p) =>
          p.scanKeysPage!({ cursor: "0", ...level, level: true }),
        );
        const firstDefect = levelPageDefect(level.pattern, level.count, first);
        if (firstDefect !== undefined) throw new Error(firstDefect);
        const second = await withProvider(provider(run, wire, connection), (p) =>
          p.scanKeysPage!({ cursor: first.cursor, ...level, level: true }),
        );
        const secondDefect = levelPageDefect(level.pattern, level.count, second);
        if (secondDefect !== undefined) throw new Error(secondDefect);
        const names = [...(first.prefixes ?? []), ...first.keys, ...(second.prefixes ?? []), ...second.keys];
        return {
          pages: [
            (first.prefixes ?? []).length + first.keys.length,
            (second.prefixes ?? []).length + second.keys.length,
          ],
          repeats: names.length - new Set(names).size,
        };
      });
    },
  },
  A25: Object.fromEntries(
    (
      [
        ["bucket", "studio-scoped/"],
        ["prefix", "studio-demo/data/"],
      ] as const
    ).map(([name, pattern]): [string, S3StepFunction] => [
      name,
      async (run, wire) => {
        const connection = connectionOf(run, { role: "root" });
        const cursor = (await withProvider(provider(run, wire, connection), (p) => walk(p, "studio-demo/", 1, 1)))
          .cursor;
        const scan = { cursor, pattern, count: 1, level: true } as const;
        return onConnected(run, wire, name, { connection, scan }, async (p) => ({
          rows: (await p.scanKeysPage!(scan)).keys.length,
        }));
      },
    ]),
  ),
  A26: { run: wireStep("A26") },
  A27: { run: wireStep("A27") },
  A28: { tagged: sourceStep("tagged", "meta/tagged.txt"), multipart: sourceStep("multipart", "data/multipart.bin") },
  A29: {
    run: (run, wire) => {
      const connection = connectionOf(run, { role: "root" });
      return step(run, wire, "run", { connection }, async () => {
        const before = wire.seen.length;
        await withProvider(provider(run, wire, connection), (p) => walk(p, "studio-demo/a/"));
        return { rows: wire.seen.slice(before).filter((request) => request.method === "HEAD").length };
      });
    },
  },
  A30: { source: sourceStep("source", "data/one-mib.bin") },
  A31: { source: sourceStep("source", "parquet/fx-zstd.parquet") },
  A32: { source: sourceStep("source", "data/empty.txt") },
  A33: { run: wireStep("A33") },
  A35: { preview: previewStep("preview", "data/rows.ndjson.gz") },
  A35b: {
    preview: previewStep("preview", "data/bomb.ndjson.gz"),
    gets: (run, wire) => {
      const command = "preview s3://studio-demo/data/bomb.ndjson.gz";
      const connection = connectionOf(run, { role: "root" });
      return step(run, wire, "gets", { connection, command }, async () => {
        const before = wire.seen.length;
        await withProvider(provider(run, wire, connection), (p) => consoleRun(p, command));
        // The object's own GETs, not the connect probe that precedes them.
        return {
          rows: wire.seen
            .slice(before)
            .filter((request) => request.method === "GET" && request.path === "/studio-demo/data/bomb.ndjson.gz")
            .length,
        };
      });
    },
  },
  A36: { preview: previewStep("preview", "data/rows.ndjson") },
  A37: {
    csv: previewStep("csv", "data/table.csv"),
    tsv: previewStep("tsv", "data/table.tsv"),
    json: previewStep("json", "data/doc.json"),
    "truncated-json": previewStep("truncated-json", "data/truncated.json"),
    "partial-ndjson": previewStep("partial-ndjson", "data/rows-partial.ndjson"),
    "utf8-boundary": previewStep("utf8-boundary", "data/utf8-boundary.txt"),
  },
  A38: {
    ...Object.fromEntries(CODECS.map((codec) => [codec, previewStep(codec, `parquet/fx-${codec}.parquet`)])),
    "two-groups": previewStep("two-groups", "parquet/fx-two-groups.parquet"),
    empty: previewStep("empty", "parquet/fx-empty.parquet"),
  },
  A39: {
    narrow: previewStep("narrow", "parquet/large/narrow-zstd.parquet"),
    wide: previewStep("wide", "parquet/large/wide-zstd.parquet"),
  },
  A40: {
    preview: previewStep("preview", "parquet/bigcells-zstd.parquet"),
    wire: (run, wire) => {
      const command = "preview s3://studio-demo/parquet/bigcells-zstd.parquet";
      const connection = connectionOf(run, { role: "root" });
      return step(run, wire, "wire", { connection, command }, async () => {
        const before = wire.seen.length;
        await withProvider(provider(run, wire, connection), (p) => consoleRun(p, command));
        const large = wire.seen.slice(before).filter((request) => {
          const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
          return range !== null && Number(range[2]) - Number(range[1]) + 1 >= 1_000_000;
        });
        return { rows: large.length };
      });
    },
  },
  A41: {
    "not-parquet": previewStep("not-parquet", "parquet/not-parquet.parquet"),
    truncated: previewStep("truncated", "parquet/truncated.parquet"),
  },
  A42: { source: sourceStep("source", "data/noext") },
  A45: { run: wireStep("A45") },
  A43: { console: consoleStep("console", "aws s3api list-object-versions --bucket studio-versions --prefix ver/") },
  A46: { console: consoleStep("console", "aws s3api list-buckets") },
  A47: {
    top: consoleStep("top", "aws s3 ls s3://studio-demo/"),
    recursive: consoleStep("recursive", "aws s3 ls s3://studio-demo/data/ --recursive"),
    continued: consoleStep("continued", "aws s3 ls \\\n  s3://studio-demo/data/ --recursive"),
  },
  A48: { console: consoleStep("console", "aws s3api head-object --bucket studio-demo --key data/table.csv") },
  A49: { csv: previewStep("csv", "data/table.csv"), parquet: previewStep("parquet", "parquet/fx-zstd.parquet") },
  A50: commandSteps(A50_COMMANDS),
  A51: commandSteps(A51_COMMANDS),
  A58: {
    console: consoleStep("console", "aws s3api list-objects-v2 --bucket studio-demo --prefix data/ --delimiter /"),
  },
  A59: { console: consoleStep("console", "aws s3api head-bucket --bucket studio-demo") },
  A60: { console: consoleStep("console", "aws s3api get-object-tagging --bucket studio-demo --key meta/tagged.txt") },
  A61: { console: consoleStep("console", "aws s3api get-bucket-location --bucket studio-demo") },
  A62: { console: consoleStep("console", "aws s3api get-bucket-versioning --bucket studio-versions") },
  A64: { console: consoleStep("console", "aws s3 ls s3://studio-demo/ --endpoint-url http://169.254.169.254/") },
  A66: Object.fromEntries(
    Object.entries(A66_TOKENS).map(([name, token]) => [
      name,
      consoleStep(name, `aws s3api list-objects-v2 --bucket studio-demo --starting-token ${token}`),
    ]),
  ),
  A66b: {
    foreign: async (run, wire) => {
      const connection = connectionOf(run, { role: "root" });
      const cursor = (await withProvider(provider(run, wire, connection), (p) => walk(p, "studio-bulk/folders/", 1)))
        .cursor;
      const token = Buffer.from(JSON.stringify({ ContinuationToken: serverToken(cursor) })).toString("base64");
      const command = `aws s3api list-objects-v2 --bucket studio-demo --starting-token ${token}`;
      return step(run, wire, "foreign", { connection, command }, async () => {
        const before = wire.seen.length;
        await withProvider(provider(run, wire, connection), (p) => consoleRun(p, command));
        // The listings the command sent, not the connect probe that precedes them.
        return {
          rows: wire.seen.slice(before).filter((request) => queryValue(request.query, "list-type") === "2").length,
        };
      });
    },
  },
  A52: {
    wire: wireStep("A52", "wire"),
    "readonly-off": consoleStep("readonly-off", "aws s3api list-buckets", { role: "root", readOnly: false }),
  },
  A53: { run: wireStep("A53") },
  A54: { run: wireStep("A54") },
  A65: {
    run: (run, wire) => {
      if (run.live === undefined) return needsLive("A65");
      const live = run.live;
      return step(run, wire, "run", { connection: connectionOf(run, { role: "root" }) }, async () => ({
        rows: live.secretHits(),
      }));
    },
  },
  A57: {
    cancel: (run, wire) => {
      const command = "aws s3 ls s3://studio-bulk/many/ --recursive";
      const connection = connectionOf(run, { role: "root" });
      return step(run, wire, "cancel", { connection, command }, () =>
        withProvider(provider(run, wire, connection), async (p) => {
          const before = wire.seen.length;
          const running = p.query(command, [], "row-a57");
          const started = Date.now();
          while (wire.seen.length === before && Date.now() - started < 5_000)
            await new Promise((resolve) => setTimeout(resolve, 2));
          const atCancel = wire.seen.length;
          await (p as unknown as { cancelQuery(queryId: string): Promise<boolean> }).cancelQuery("row-a57");
          const outcome = await running.then(
            () => "finished",
            (error: unknown) => (error instanceof QueryCancelledError ? "cancelled" : (error as Error).message),
          );
          if (outcome !== "cancelled") throw new Error(`the listing ${outcome} instead of ending cancelled`);
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { rows: wire.seen.length - atCancel };
        }),
      );
    },
    again: walkStep("again", "studio-bulk/many/", { role: "root" }, 1),
  },
};

/** A63's steps: built through the tunnel check's factory path, the only one that opens a tunnel. */
async function tunnelStep(
  run: S3RunContext,
  wire: Wire,
  name: string,
  farEnd: string,
  port: number,
  tls: boolean,
): Promise<S3StepRun> {
  if (run.tunnel === undefined) throw new Error("A63 runs only in tests/live/s3-tunnel-check.ts");
  const tunnel = run.tunnel;
  const base = connectionOf(run, { role: "browse" });
  const connection = {
    ...base,
    id: `s3-live-tunnel-${name}`,
    host: farEnd,
    port,
    sshTunnel: tunnel.sshTunnel,
    ...(tls ? { ssl: { mode: "verify-full" as const, caCert: run.ca } } : { ssl: undefined }),
  } as DatabaseConnection;
  return step(run, wire, name, { connection }, async () => {
    const p = await tunnel.open(connection);
    await p.getHealth();
    return { rows: (await p.listObjects([], "bucket")).length };
  });
}

/** Runs the given steps of one row in order, with one request recorder for the row. */
export async function runS3Row(id: string, run: S3RunContext, steps: readonly string[]): Promise<readonly S3StepRun[]> {
  const runners = S3_RUNNERS[id];
  if (runners === undefined) throw new Error(`no runner for ${id}`);
  const wire = observe(run.createTransport);
  const runs: S3StepRun[] = [];
  for (const name of steps) {
    const runner = runners[name];
    if (runner === undefined) throw new Error(`${id} has no step ${name}`);
    runs.push(await runner(run, wire));
  }
  return runs;
}

/** The steps of a row that a target runs: every step of its cell that is not not-applicable. */
export function applicableSteps(row: S3AcceptanceRow, target: S3Target): string[] {
  return row.expect[target].filter(({ outcome }) => outcome.kind !== "not-applicable").map(({ step: name }) => name);
}

/** The object-surface contract the replay asserts: root, no pin, both kinds. */
export const S3_CONFORMANCE: ObjectSurfaceExpectation = {
  containers: [],
  kinds: { bucket: 5 },
  sampleObject: { path: ["studio-demo"], kind: "bucket" },
  // The Source tab answers a missing bucket or object with an unavailable part and never raises, so the authored
  // absence is a bucket name the bucket rule refuses before any request: it names nothing on any server.
  absentSource: { path: ["-no-such-bucket-"], kind: "bucket" },
  keyBrowserSample: { path: [joinVirtualKey("studio-demo", "data/table.csv")], kind: "object" },
  noColumnKinds: true,
};

/** The `surface` scenario: the assertion is passed in, so this module loads under Node without the Bun-only helper. */
export async function runS3Surface(
  run: S3RunContext,
  assertSurface: (provider: S3Provider) => Promise<void>,
): Promise<readonly S3StepRun[]> {
  const wire = observe(run.createTransport);
  const connection = connectionOf(run, { role: "root" });
  return [
    await step(run, wire, "surface", { connection }, () =>
      withProvider(provider(run, wire, connection), async (p) => (await assertSurface(p), {})),
    ),
  ];
}

// ============================================================================
// The bucket fingerprint: proof that a run changed nothing
// ============================================================================

export const S3_FIXTURE_BUCKETS = [
  "studio-demo",
  "studio-scoped",
  "studio-versions",
  "studio-bulk",
  "studio-empty",
] as const;

function call() {
  return { signal: AbortSignal.timeout(60_000), deadline: Date.now() + 60_000 };
}

/**
 * The sha256 per fixture bucket of every key, size and ETag a ListObjectsV2 walk answers, and for studio-versions of
 * every version entry as well. A server that answers ListObjectVersions with 501 (Garage) has no versions to hash, so
 * that bucket's digest is its listing alone; any other error fails the fingerprint.
 */
export async function s3Fingerprint(
  target: S3Target,
  principals: S3Principals,
  createTransport: S3TransportFactory,
  clock: () => Date = () => new Date(),
  ca?: string,
): Promise<Readonly<Record<string, string>>> {
  const options = buildS3ConnectionOptions(
    s3LiveConnection(target, principals, { role: "root" }, ca) as Parameters<typeof buildS3ConnectionOptions>[0],
    { executionReadOnly: true, queryTimeout: 60_000 },
  );
  if (options.credentials === null) throw new Error("the fingerprint signs as root, and root has no key pair");
  const transport = createTransport({
    origin: options.origin,
    tls: options.tls,
    maxSockets: 1,
    headers: {},
    requestHeaderNames: ["range"],
    responseHeaders: S3_RESPONSE_HEADERS,
    signer: s3Signer(options.credentials, options.region, clock),
  });
  const client = createS3Client(transport);
  try {
    const fingerprint: Record<string, string> = {};
    for (const bucket of S3_FIXTURE_BUCKETS) {
      const hash = createHash("sha256");
      let token: string | undefined;
      do {
        const page = await client.listObjectsV2(
          { bucket, prefix: "", maxKeys: 1000, ...(token === undefined ? {} : { continuationToken: token }) },
          call(),
        );
        for (const entry of page.keys) hash.update(`${entry.key}\u0000${entry.size}\u0000${entry.etag ?? ""}\n`);
        token = page.isTruncated ? page.nextToken : undefined;
      } while (token !== undefined);
      if (bucket === "studio-versions") {
        try {
          const versions = await client.listObjectVersions({ bucket, prefix: "", maxKeys: 1000 }, call());
          for (const entry of versions.entries)
            hash.update(
              `v\u0000${entry.key}\u0000${entry.versionId ?? ""}\u0000${entry.deleteMarker}\u0000${entry.size ?? ""}\u0000${entry.etag ?? ""}\n`,
            );
        } catch (error) {
          if (!(error instanceof S3ServerError && error.status === 501)) throw error;
        }
      }
      fingerprint[bucket] = hash.digest("hex");
    }
    return fingerprint;
  } finally {
    transport.close();
  }
}

// ============================================================================
// The recorder the harness and the live check share
// ============================================================================

/**
 * A recording run: the factory and the signer wrapper a provider is built with, and the exchanges they saw. The signer
 * runs inside the transport at send time, so the signer wrapper records each input and the headers it returned, and
 * the transport wrapper pairs that record with the request's target and its answer, in order. A signed request must
 * leave exactly one new signer record, so a concurrent read can never pair a request with another's signature. An
 * unsigned request is recorded from the same input the transport builds, so the replay rebuilds the same headers.
 */
export function s3Recorder(factory: S3TransportFactory, scenario: string) {
  const exchanges: S3Exchange[] = [];
  const signed: { readonly input: SigningInput; readonly headers: Readonly<Record<string, string>> }[] = [];
  let step = scenario;
  const createTransport: S3TransportFactory = (transportOptions) => {
    const inner = factory(transportOptions);
    return {
      async request(request) {
        const signs = transportOptions.signer !== undefined;
        const before = signed.length;
        const response = await inner.request(request);
        if (signs && signed.length !== before + 1)
          throw new Error(
            `${scenario} step ${step}: a signed request left ${signed.length - before} signer records, not exactly one`,
          );
        const record = signs ? signed[before] : undefined;
        const sent =
          record === undefined
            ? recordedRequest(signingInput(transportOptions, request, undefined), {})
            : recordedRequest(record.input, record.headers);
        exchanges.push({ step, request: sent, answer: answerOf(response) });
        return response;
      },
      close: () => inner.close(),
    };
  };
  return {
    exchanges,
    createTransport,
    signerWrapper: (signer: RequestSigner) =>
      recordingSigner(signer, (input, headers) => void signed.push({ input, headers })),
    setStep(name: string) {
      step = name;
    },
  };
}
