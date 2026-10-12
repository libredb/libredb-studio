/**
 * The evidence scrub of the Firestore captures: the only path from an exchange with a live Firestore, Google token
 * endpoint or metadata server to a file under tests/fixtures/firestore/, on the model of
 * tests/helpers/kubernetes-evidence-scrub.ts.
 *
 * Every project id, named database id and principal the run met becomes one placeholder shaped to pass the id rules
 * (`scrubbed-project-<n>`, `scrubbed-db-<n>`, `principal-<n>@scrubbed.invalid`), the same in paths, bodies and answers,
 * so a request built from a replayed answer is the request that was recorded. A `demo-` project and `(default)` name
 * nothing real and are kept. The index link of a FAILED_PRECONDITION answer carries the index name inside a base64url
 * protobuf, which is decoded, rewritten with valid length prefixes and re-encoded. Token answers keep their keys and
 * lose their values; any access token, refresh token, client secret, JWT, key id or PEM key left in free text is
 * replaced. Page tokens and document names are kept except for those ids.
 *
 * `render` refuses the whole set, writing nothing, while any file holds a secret the run was given, an access token,
 * a refresh token, a client secret, a JWT, a private key that is not the placeholder, or an original project or
 * database id. The error names the file and what it holds, never the value.
 */
import type { FirestoreCapture, FirestoreExchange } from "./firestore-replay";

export interface FirestoreEvidenceSecrets {
  readonly projectIds: readonly string[];
  readonly databaseIds: readonly string[];
  readonly principals: readonly string[];
  readonly secrets: readonly string[];
  readonly privateKeys: readonly string[];
}

export const FIRESTORE_EVIDENCE_LEAK_SENTENCE =
  "The evidence holds a token, a key, an assertion, a refresh token, a client secret, a key id or a project id the scrub missed: nothing was written.";

export class FirestoreEvidenceLeakError extends Error {
  constructor(readonly findings: readonly string[]) {
    super(FIRESTORE_EVIDENCE_LEAK_SENTENCE);
    this.name = "FirestoreEvidenceLeakError";
  }
}

const SECRET_KEYS = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "private_key",
  "private_key_id",
  "assertion",
]);
const ACCESS_TOKEN = /ya29\.[\w.-]+/g;
const REFRESH_TOKEN = /1\/\/0[\w-]{10,}/g;
const CLIENT_SECRET = /GOCSPX-[\w-]+/g;
const JWT = /\beyJ[\w-]*\.eyJ[\w-]*\.[\w-]+/g;
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;
const INDEX_LINK = /https:\/\/console\.firebase\.google\.com\/[^\s"']*create_composite=[A-Za-z0-9_-]+=*/g;
const KEPT_DATABASE = "(default)";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** An id as a whole id: not preceded or followed by a letter, a digit, `-` or `.`. */
const wholeId = (id: string): RegExp => new RegExp(`(?<![A-Za-z0-9.-])${escapeRegExp(id)}(?![A-Za-z0-9-])`, "g");

function readVarint(bytes: Buffer, at: number): { readonly value: number; readonly next: number } {
  let value = 0;
  let shift = 0;
  let index = at;
  for (;;) {
    if (index >= bytes.length) throw new Error("the index link's protobuf ends inside a varint");
    const byte = bytes[index];
    value += (byte & 0x7f) * 2 ** shift;
    index += 1;
    if ((byte & 0x80) === 0) return { value, next: index };
    shift += 7;
  }
}

function writeVarint(value: number): Buffer {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return Buffer.from(out);
}

/** The top-level fields of a protobuf, each length-delimited UTF-8 field passed through `rewrite`. */
function rewriteProto(bytes: Buffer, rewrite: (text: string) => string): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  while (at < bytes.length) {
    const tag = readVarint(bytes, at);
    const wireType = tag.value % 8;
    const start = at;
    if (wireType === 0) {
      at = readVarint(bytes, tag.next).next;
      parts.push(bytes.subarray(start, at));
    } else if (wireType === 1 || wireType === 5) {
      at = tag.next + (wireType === 1 ? 8 : 4);
      parts.push(bytes.subarray(start, at));
    } else if (wireType === 2) {
      const length = readVarint(bytes, tag.next);
      const field = bytes.subarray(length.next, length.next + length.value);
      at = length.next + length.value;
      const text = field.toString("utf8");
      const utf8 = Buffer.from(text, "utf8").equals(field);
      const rewritten = utf8 ? Buffer.from(rewrite(text), "utf8") : field;
      parts.push(bytes.subarray(start, tag.next), writeVarint(rewritten.length), rewritten);
    } else {
      throw new Error(`the index link's protobuf has wire type ${wireType}, which this scrub does not read`);
    }
  }
  return Buffer.concat(parts);
}

export function rewriteIndexLink(link: string, rewrite: (text: string) => string): string {
  const url = new URL(link);
  const encoded = url.searchParams.get("create_composite") ?? "";
  const proto = rewriteProto(Buffer.from(encoded, "base64url"), rewrite);
  const padded = encoded.endsWith("=");
  const base64 = proto.toString("base64url");
  const value = padded ? `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}` : base64;
  const path = rewrite(url.pathname);
  return `${url.origin}${path}?create_composite=${value}`;
}

export class FirestoreEvidenceScrubber {
  private readonly projects = new Map<string, string>();
  private readonly databases = new Map<string, string>();
  private readonly principals = new Map<string, string>();

  constructor(private readonly secrets: FirestoreEvidenceSecrets) {
    for (const id of secrets.projectIds) {
      if (!id.startsWith("demo-") && !this.projects.has(id)) {
        this.projects.set(id, `scrubbed-project-${this.projects.size + 1}`);
      }
    }
    for (const id of secrets.databaseIds) {
      if (id !== KEPT_DATABASE && !this.databases.has(id))
        this.databases.set(id, `scrubbed-db-${this.databases.size + 1}`);
    }
    for (const email of secrets.principals) {
      if (!this.principals.has(email))
        this.principals.set(email, `principal-${this.principals.size + 1}@scrubbed.invalid`);
    }
  }

  /** One string with every id, principal, token, key and index link replaced. */
  text(value: string): string {
    let out = value.replace(
      PEM_BLOCK,
      (_block, label: string) => `-----BEGIN ${label}-----\nPLACEHOLDER\n-----END ${label}-----`,
    );
    for (const secret of this.secrets.secrets) if (secret !== "") out = out.split(secret).join("<secret>");
    out = out.replace(ACCESS_TOKEN, "<token>").replace(REFRESH_TOKEN, "<refresh-token>");
    out = out.replace(CLIENT_SECRET, "<client-secret>").replace(JWT, "<jwt>");
    out = out.replace(INDEX_LINK, (link) => rewriteIndexLink(link, (text) => this.ids(text)));
    return this.ids(out);
  }

  exchange(raw: FirestoreExchange): FirestoreExchange {
    return {
      lane: raw.lane,
      request: {
        ...raw.request,
        path: this.text(raw.request.path),
        ...(raw.request.body === undefined ? {} : { body: this.body(raw.request.body) }),
      },
      response: { ...raw.response, text: this.body(raw.response.text) },
    };
  }

  capture(raw: FirestoreCapture): FirestoreCapture {
    return {
      scenario: raw.scenario,
      lanes: raw.lanes.map((lane) => ({ ...lane, origin: this.text(lane.origin) })),
      exchanges: raw.exchanges.map((exchange) => this.exchange(exchange)),
    };
  }

  render(files: Readonly<Record<string, unknown>>): Record<string, string> {
    const rendered: Record<string, string> = {};
    const findings: string[] = [];
    for (const [name, value] of Object.entries(files)) {
      const text = `${JSON.stringify(value, null, 2)}\n`;
      for (const label of this.leaks(text)) findings.push(`${name} holds ${label}`);
      rendered[name] = text;
    }
    if (findings.length > 0) throw new FirestoreEvidenceLeakError(findings);
    return rendered;
  }

  /** Project ids, database ids and principals, raw and percent-encoded. */
  private ids(text: string): string {
    let out = text;
    for (const [email, placeholder] of this.principals) {
      out = out.split(email).join(placeholder).split(encodeURIComponent(email)).join(encodeURIComponent(placeholder));
    }
    for (const [id, placeholder] of this.projects) out = out.replace(wholeId(id), placeholder);
    for (const [id, placeholder] of this.databases) out = out.replace(wholeId(id), placeholder);
    return out;
  }

  /** A JSON body with every string scrubbed and every secret-named key emptied; a non-JSON body as text. */
  private body(text: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return this.text(text);
    }
    return JSON.stringify(this.value(parsed));
  }

  private value(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.value(item));
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[this.text(key)] = SECRET_KEYS.has(key) && typeof item === "string" ? "<scrubbed>" : this.value(item);
    }
    return out;
  }

  private leaks(text: string): string[] {
    const labels: string[] = [];
    if (this.secrets.secrets.some((secret) => secret !== "" && text.includes(secret))) {
      labels.push("a token, a refresh token, a client secret, a key id or an assertion the run was given");
    }
    if (new RegExp(ACCESS_TOKEN.source).test(text)) labels.push("an access token");
    if (new RegExp(REFRESH_TOKEN.source).test(text)) labels.push("a refresh token");
    if (new RegExp(CLIENT_SECRET.source).test(text)) labels.push("a client secret");
    if (new RegExp(JWT.source).test(text)) labels.push("a JWT");
    if (/BEGIN [A-Z ]*PRIVATE KEY-----\\n(?!PLACEHOLDER)/.test(text)) labels.push("a private key");
    const ids = [...this.projects.keys(), ...this.databases.keys(), ...this.principals.keys()];
    if (ids.some((id) => new RegExp(wholeId(id).source).test(text))) {
      labels.push("the original project id or database id");
    }
    return labels;
  }
}

export function redactForTerminal(
  text: string,
  secrets: Pick<FirestoreEvidenceSecrets, "secrets" | "privateKeys">,
): string {
  let out = text;
  for (const pem of secrets.privateKeys) if (pem !== "") out = out.split(pem).join("<pem>");
  for (const secret of secrets.secrets) if (secret !== "") out = out.split(secret).join("<secret>");
  return out;
}
