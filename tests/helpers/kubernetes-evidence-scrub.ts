/**
 * The evidence scrub of the Kubernetes capture: the only path from an exchange with a live API server to a file under
 * tests/fixtures/kubernetes/, on the model of tests/helpers/databend-evidence-scrub.ts.
 *
 * An exchange keeps only what the provider's transport hands it and sends: the method, the path and query, the Accept
 * header and the request body; the status, the content type, the Retry-After and the body of the answer. No other
 * header is recorded, so an `Authorization`, a cookie or the API server's `Audit-Id` never reaches a file.
 *
 * Inside the request and the answer it replaces what identifies a cluster or a person, with placeholders of the same
 * shape, so a replayed answer still parses and a request the provider builds from a replayed answer is the request
 * that was recorded: every UUID (object UIDs, the credential id of a token, a node's system UUID) becomes
 * `00000000-0000-4000-8000-<n>`, every 32-digit hex id `0…<n>`, every IPv4 address but loopback `192.0.2.<n>` (the
 * documentation range), every IPv6 address but loopback `2001:db8::<n>`, every JWT `<jwt>`, every PEM block, and every
 * base64 string, or base64 run inside a string, that decodes to one, a fixed placeholder block. The same value gets the
 * same placeholder for the life of the scrubber, so one UID reads the same in every file of a capture.
 *
 * Secret data is kept only in the namespaces where the sample data plants its fake markers, so the redaction tests can
 * prove the markers never leave the provider; every other Secret (a cluster's own, such as k3s's serving key) loses
 * its `data` and `stringData` values and its last-applied annotation here. A Node loses its `k3s.io/node-*`
 * annotations, which carry the server's arguments.
 *
 * `render` refuses the whole set, writing nothing, while any file holds a token or certificate the run was given, in
 * raw or base64 form, a PEM private key (base64 of one inside a longer string included), a JWT, or an IPv4 or IPv6
 * address the placeholders missed. The error names the file and
 * what it holds, never the value.
 */

/** What a run sends or meets that must never reach a capture. */
export interface KubernetesEvidenceSecrets {
  /** Every bearer token of the run's personas. */
  readonly tokens: readonly string[];
  /** Every PEM text the run was given: the cluster CA, the admin's client certificate and key. */
  readonly pems: readonly string[];
  /** The namespaces whose Secrets hold the sample data's planted fake values, which are kept. */
  readonly plantedNamespaces: readonly string[];
}

/** One request and its answer, as the provider's transport saw them. */
export interface KubernetesExchange {
  readonly request: {
    readonly method: "GET" | "POST";
    /** The path and query, without the origin. */
    readonly path: string;
    readonly accept?: string;
    readonly body?: string;
  };
  readonly response: {
    readonly status: number;
    readonly contentType: string | null;
    readonly retryAfter: string | null;
    readonly text: string;
  };
}

export const KUBERNETES_EVIDENCE_LEAK_SENTENCE =
  "The evidence holds a token, a certificate, a private key, a JWT or an address the scrub missed: nothing was written.";

export class KubernetesEvidenceLeakError extends Error {
  constructor(readonly findings: readonly string[]) {
    super(KUBERNETES_EVIDENCE_LEAK_SENTENCE);
    this.name = "KubernetesEvidenceLeakError";
  }
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX32 = /\b[0-9a-f]{32}\b/gi;
const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;
/** A full or compressed IPv6 address, a leading `::` form included unless an IPv4 tail follows it (`::ffff:a.b.c.d`). */
const IPV6 =
  /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}(?!\.\d))(?![\w:])/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;
const BASE64 = /^[A-Za-z0-9+/]{16,}={0,2}$/;
/** A run of base64 inside a longer string, long enough to hold the start of a PEM block. */
const EMBEDDED_BASE64 = /[A-Za-z0-9+/]{40,}={0,2}/g;
const KEPT_ADDRESSES = new Set(["127.0.0.1", "0.0.0.0", "::1", "::"]);
const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";
const SCRUBBED_VALUE = Buffer.from("<scrubbed>", "utf8").toString("base64");

/** The placeholder block a PEM block becomes, with its own BEGIN and END label kept. */
function placeholderPem(label: string): string {
  return `-----BEGIN ${label}-----\nPLACEHOLDER\n-----END ${label}-----`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A base64 string's text when it decodes to UTF-8 that holds a PEM block, else undefined. */
function decodedPem(text: string): string | undefined {
  if (!BASE64.test(text)) return undefined;
  const decoded = Buffer.from(text, "base64").toString("utf8");
  return decoded.includes("-----BEGIN ") ? decoded : undefined;
}

/**
 * A base64 run's PEM text and the characters before the run's first whole quantum, when the run, read from one of its
 * four alignments, decodes to text that holds a PEM block, else undefined. A run inside a longer string can start
 * mid-word (`key:abc<base64>`), so each alignment is tried.
 */
function embeddedPem(run: string): { readonly prefix: string; readonly pem: string } | undefined {
  for (let skip = 0; skip < 4; skip += 1) {
    const decoded = Buffer.from(run.slice(skip), "base64").toString("utf8");
    if (decoded.includes("-----BEGIN ")) return { prefix: run.slice(0, skip), pem: decoded };
  }
  return undefined;
}

export class KubernetesEvidenceScrubber {
  private readonly uuids = new Map<string, string>();
  private readonly hexes = new Map<string, string>();
  private readonly v4 = new Map<string, string>();
  private readonly v6 = new Map<string, string>();

  constructor(private readonly secrets: KubernetesEvidenceSecrets) {}

  /** The exchange with every identifier replaced and every Secret outside the planted namespaces emptied. */
  exchange(raw: KubernetesExchange): KubernetesExchange {
    const secretsRequest = /\/secrets(?:\/|\?|$)/.test(raw.request.path.split("?")[0] ?? "");
    return {
      request: {
        method: raw.request.method,
        path: this.path(raw.request.path),
        ...(raw.request.accept === undefined ? {} : { accept: raw.request.accept }),
        ...(raw.request.body === undefined ? {} : { body: this.body(raw.request.body, false) }),
      },
      response: {
        status: raw.response.status,
        contentType: raw.response.contentType,
        retryAfter: raw.response.retryAfter,
        text: this.body(raw.response.text, secretsRequest),
      },
    };
  }

  /** Each file as indented JSON with a final newline, or a {@link KubernetesEvidenceLeakError} and no text at all. */
  render(files: Readonly<Record<string, unknown>>): Record<string, string> {
    const rendered: Record<string, string> = {};
    const findings: string[] = [];
    for (const [name, value] of Object.entries(files)) {
      const text = `${JSON.stringify(value, null, 2)}\n`;
      for (const label of this.leaks(text)) findings.push(`${name} holds ${label}`);
      rendered[name] = text;
    }
    if (findings.length > 0) throw new KubernetesEvidenceLeakError(findings);
    return rendered;
  }

  /** The path with each segment and each query value scrubbed, the query keys in their order. */
  private path(path: string): string {
    const at = path.indexOf("?");
    const route = (at === -1 ? path : path.slice(0, at))
      .split("/")
      .map((segment) => this.text(segment))
      .join("/");
    if (at === -1) return route;
    const scrubbed = new URLSearchParams();
    for (const [key, value] of new URLSearchParams(path.slice(at + 1))) scrubbed.append(key, this.text(value));
    return `${route}?${scrubbed.toString()}`;
  }

  /** A body: JSON, one JSON object per line (a watch), or plain text (a log, the OpenAPI index). */
  private body(text: string, secretsRequest: boolean): string {
    const whole = this.parse(text);
    if (whole !== undefined) return JSON.stringify(this.value(whole, secretsRequest));
    const lines = text.split("\n");
    const filled = lines.filter((line) => line.trim() !== "");
    const events = filled.map((line) => this.parse(line));
    if (filled.length > 0 && events.every((event) => event !== undefined)) {
      return lines
        .map((line) => {
          const event = line.trim() === "" ? undefined : this.parse(line);
          return event === undefined ? line : JSON.stringify(this.value(event, secretsRequest));
        })
        .join("\n");
    }
    return this.text(text);
  }

  private parse(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /** A parsed value with every string scrubbed, every Secret it holds emptied where it must be. */
  private value(value: unknown, secretsRequest: boolean): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.value(item, secretsRequest));
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[this.text(key)] = this.value(item, secretsRequest);
    this.emptySecret(out, secretsRequest);
    this.dropNodeArguments(out);
    return out;
  }

  /**
   * A Secret outside the planted namespaces keeps its keys and loses their values. An object is a Secret when its
   * kind says so, or when the request asked for Secrets and it has metadata, as a typed list's items do without a kind
   * and a Table row's PartialObjectMetadata does with another: its last-applied annotation holds the values all the
   * same. The list or Table around them has no namespace and nothing to lose.
   */
  private emptySecret(object: Record<string, unknown>, secretsRequest: boolean): void {
    const metadata = isRecord(object.metadata) ? object.metadata : undefined;
    const secret = object.kind === "Secret" || (secretsRequest && metadata !== undefined);
    if (!secret || metadata === undefined) return;
    const namespace = typeof metadata.namespace === "string" ? metadata.namespace : "";
    if (this.secrets.plantedNamespaces.includes(namespace)) return;
    if (isRecord(object.data)) {
      object.data = Object.fromEntries(Object.keys(object.data).map((key) => [key, SCRUBBED_VALUE]));
    }
    delete object.stringData;
    if (isRecord(metadata.annotations)) delete metadata.annotations[LAST_APPLIED];
  }

  private dropNodeArguments(object: Record<string, unknown>): void {
    if (object.kind !== "Node" || !isRecord(object.metadata) || !isRecord(object.metadata.annotations)) return;
    for (const key of Object.keys(object.metadata.annotations)) {
      if (key.startsWith("k3s.io/node-")) delete object.metadata.annotations[key];
    }
  }

  /** One string with every identifier, address, token and certificate replaced. */
  private text(text: string): string {
    const pem = decodedPem(text);
    if (pem !== undefined) return Buffer.from(this.text(pem), "utf8").toString("base64");
    let out = text.replace(EMBEDDED_BASE64, (run) => {
      const found = embeddedPem(run);
      return found === undefined
        ? run
        : `${found.prefix}${Buffer.from(this.text(found.pem), "utf8").toString("base64")}`;
    });
    out = out.replace(PEM_BLOCK, (_block, label: string) => placeholderPem(label));
    for (const token of this.secrets.tokens) if (token !== "") out = out.split(token).join("<token>");
    out = out.replace(JWT, "<jwt>");
    out = out.replace(UUID, (uuid) =>
      this.placeholder(this.uuids, uuid.toLowerCase(), (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`),
    );
    out = out.replace(HEX32, (hex) =>
      this.placeholder(this.hexes, hex.toLowerCase(), (n) => String(n).padStart(32, "0")),
    );
    out = out.replace(IPV4, (address) =>
      KEPT_ADDRESSES.has(address) ? address : this.placeholder(this.v4, address, (n) => `192.0.2.${n}`),
    );
    out = out.replace(IPV6, (address) =>
      KEPT_ADDRESSES.has(address)
        ? address
        : this.placeholder(this.v6, address.toLowerCase(), (n) => `2001:db8::${n.toString(16)}`),
    );
    return out;
  }

  private placeholder(map: Map<string, string>, value: string, make: (n: number) => string): string {
    const known = map.get(value);
    if (known !== undefined) return known;
    const made = make(map.size + 1);
    map.set(value, made);
    return made;
  }

  /** What the text holds that no capture may, by label. */
  private leaks(text: string): string[] {
    const labels: string[] = [];
    const strings = stringsOf(JSON.parse(text));
    const decoded = strings.map((value) => (BASE64.test(value) ? Buffer.from(value, "base64").toString("utf8") : ""));
    const embedded = strings.flatMap((value) =>
      [...value.matchAll(EMBEDDED_BASE64)].map((match) => embeddedPem(match[0])?.pem ?? ""),
    );
    const corpus = [...strings, ...decoded, ...embedded].join("\n");
    const base64 = (secret: string) => Buffer.from(secret, "utf8").toString("base64").replace(/=+$/, "");
    if (
      this.secrets.tokens.some((token) => token !== "" && [token, base64(token)].some((form) => corpus.includes(form)))
    ) {
      labels.push("a token");
    }
    const flat = corpus.replace(/\s/g, "");
    const pemForms = this.secrets.pems.flatMap((pem) => [
      pem
        .replace(/-----[A-Z0-9 ]+-----/g, "")
        .replace(/\s/g, "")
        .slice(0, 64),
      base64(pem).slice(0, 64),
    ]);
    if (pemForms.some((form) => form !== "" && flat.includes(form)))
      labels.push("a certificate or key the run was given");
    if (/BEGIN [A-Z ]*PRIVATE KEY-----\n(?!PLACEHOLDER)/.test(corpus)) labels.push("a private key");
    if (new RegExp(JWT.source).test(corpus)) labels.push("a JWT");
    const addresses = [...corpus.matchAll(IPV4)].map((match) => match[0]);
    if (addresses.some((address) => !KEPT_ADDRESSES.has(address) && !address.startsWith("192.0.2."))) {
      labels.push("an IPv4 address");
    }
    const v6 = [...corpus.matchAll(IPV6)].map((match) => match[0].toLowerCase());
    if (v6.some((address) => !KEPT_ADDRESSES.has(address) && !address.startsWith("2001:db8:"))) {
      labels.push("an IPv6 address");
    }
    return labels;
  }
}

/** Every string and every key of a JSON value, and of each string that is itself a JSON text, as a watch body is. */
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    for (const line of value.split("\n")) {
      if (!/^\s*[[{]/.test(line)) continue;
      try {
        stringsOf(JSON.parse(line), out);
      } catch {
        // Plain text, already in the list.
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) stringsOf(item, out);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      stringsOf(item, out);
    }
  }
  return out;
}

/** A line for the operator's terminal with every token and PEM text the run was given replaced. */
export function redactForTerminal(text: string, secrets: Pick<KubernetesEvidenceSecrets, "tokens" | "pems">): string {
  let out = text;
  for (const token of secrets.tokens)
    if (token !== "") out = out.replace(new RegExp(escapeRegExp(token), "g"), "<token>");
  for (const pem of secrets.pems) if (pem !== "") out = out.split(pem).join("<pem>");
  return out;
}
