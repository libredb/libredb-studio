/**
 * The scrub every S3 capture passes before tests/live/s3-evidence.ts writes it.
 *
 * - The signature never reaches a file: a capture keeps the authorization's scheme, credential scope and
 *   SignedHeaders only (tests/helpers/s3-wire.ts, parseAuthorization).
 * - x-amz-date, the scope's date and the answer's `date` are kept: they are not secrets, and the replay signs with
 *   them and builds its clock from them.
 * - x-amz-request-id and x-request-id become <request-id>; normalizeMessage gives the runner's summaries the same
 *   treatment, so a recorded and a live result of one scenario are equal.
 * - Only the answer headers the provider asks the transport for are kept: S3_RESPONSE_HEADERS and its prefix,
 *   imported from the provider, with no second list.
 * - Continuation tokens are kept as sent and received, byte for byte: the replay must send them back exactly.
 * - An exchange body over 512 KiB is refused, so a scenario is designed to stay under it.
 * - Nothing is written while the file would hold a fixture secret raw, percent-encoded, form-encoded, in standard or
 *   URL-safe base64 with or without padding, escaped in JSON, or escaped in XML with named or numeric references;
 *   binary bodies are decoded before the search, since base64 of a longer body need not contain base64 of the secret.
 *   A text body that holds base64 of a longer value is searched for the secret's base64 and base64url core at each of
 *   the three byte offsets, the characters that depend on the neighbouring bytes dropped.
 * - maskSecrets is the one mask every line the S3 live check, tunnel check and evidence harness print passes.
 */
import { S3_RESPONSE_HEADERS } from "@/lib/db/providers/objectstore/s3/headers";
import { bodyBytes, type S3Capture, type S3Exchange } from "./s3-wire";

export const S3_EXCHANGE_BODY_MAX_BYTES = 512 * 1024;
export const S3_CAPTURES_MAX_BYTES = 8 * 1024 * 1024;
export const REQUEST_ID_PLACEHOLDER = "<request-id>";
const REQUEST_ID_HEADERS = new Set(["x-amz-request-id", "x-request-id"]);

export interface S3FixtureSecret {
  /** What a finding names, such as "root password"; the value is never printed. */
  readonly label: string;
  readonly value: string;
}

/**
 * The base64 characters of `value` that do not depend on its neighbours when it starts `offset` bytes into a longer
 * value: the first characters, which share bits with the bytes before it, and the last, which share bits with the
 * bytes after it, are dropped.
 */
function base64Core(value: string, offset: 0 | 1 | 2): string {
  const bytes = Buffer.concat([Buffer.alloc(offset), Buffer.from(value, "utf8")]);
  return bytes.toString("base64").slice(Math.ceil((offset * 4) / 3), Math.floor((bytes.length * 4) / 3));
}

/** Every spelling of a secret a file could hold. */
export function secretEncodings(value: string): readonly { readonly encoding: string; readonly text: string }[] {
  const base64 = Buffer.from(value, "utf8").toString("base64");
  const base64url = Buffer.from(value, "utf8").toString("base64url");
  const percent = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const spellings = [
    { encoding: "raw", text: value },
    { encoding: "percent-encoded", text: percent },
    {
      encoding: "percent-encoded in lower case",
      text: percent.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    },
    { encoding: "form-encoded", text: percent.replace(/%20/g, "+") },
    { encoding: "base64", text: base64 },
    { encoding: "base64 without padding", text: base64.replace(/=+$/, "") },
    { encoding: "base64url", text: base64url },
    { encoding: "JSON-escaped", text: JSON.stringify(value).slice(1, -1) },
    {
      encoding: "XML-escaped",
      text: value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;"),
    },
    {
      encoding: "XML-escaped with numeric references",
      text: value
        .replace(/&/g, "&amp;")
        .replace(/'/g, "&#39;")
        .replace(/"/g, "&#34;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;"),
    },
    ...([0, 1, 2] as const).flatMap((offset) => {
      const core = base64Core(value, offset);
      return [
        { encoding: `base64 core at byte offset ${offset}`, text: core },
        {
          encoding: `base64url core at byte offset ${offset}`,
          text: core.replace(/\+/g, "-").replace(/\//g, "_"),
        },
      ];
    }),
  ];
  const seen = new Set<string>();
  return spellings.filter(({ text }) => (seen.has(text) ? false : (seen.add(text), true)));
}

/** `<label> <encoding>` for every secret spelling found in `text`; the first spelling found per secret. */
export function secretHits(text: string, secrets: readonly S3FixtureSecret[]): string[] {
  const hits: string[] = [];
  for (const secret of secrets) {
    const found = secretEncodings(secret.value).find(({ text: spelling }) => text.includes(spelling));
    if (found !== undefined) hits.push(`${secret.label} ${found.encoding}`);
  }
  return hits;
}

/** `text` with every spelling of every secret replaced by <secret>, the longest spelling first. */
export function maskSecrets(text: string, secrets: readonly S3FixtureSecret[]): string {
  const spellings = secrets
    .flatMap((secret) => secretEncodings(secret.value).map(({ text: spelling }) => spelling))
    .sort((a, b) => b.length - a.length);
  return spellings.reduce((out, spelling) => out.split(spelling).join("<secret>"), text);
}

/** A provider message as a summary records it: the request id clause of an unclassified failure dropped. */
export function normalizeMessage(message: string): string {
  return message.replace(/ \(request id [^)]*\)/g, "");
}

function allowed(name: string): boolean {
  return (
    S3_RESPONSE_HEADERS.names.includes(name) ||
    (S3_RESPONSE_HEADERS.prefixes ?? []).some((prefix) => name.startsWith(prefix))
  );
}

function scrubExchange(file: string, exchange: S3Exchange): S3Exchange {
  const size = bodyBytes(exchange.answer.body).length;
  if (size > S3_EXCHANGE_BODY_MAX_BYTES)
    throw new Error(`${file} step ${exchange.step}: the answer body holds ${size} bytes, over 512 KiB`);
  const requestHeaders = Object.fromEntries(
    Object.entries(exchange.request.headers).filter(([name]) => name !== "authorization"),
  );
  return {
    step: exchange.step,
    request: { ...exchange.request, headers: requestHeaders },
    answer: {
      ...exchange.answer,
      headers: exchange.answer.headers
        .filter(([name]) => allowed(name))
        .map(([name, value]) => [name, REQUEST_ID_HEADERS.has(name) ? REQUEST_ID_PLACEHOLDER : value] as const),
    },
  };
}

/** The file text of one capture, or an error naming the file and the reason; nothing is written on an error. */
export function scrubCapture(capture: S3Capture, secrets: readonly S3FixtureSecret[]): string {
  const scrubbed: S3Capture = {
    ...capture,
    exchanges: capture.exchanges.map((exchange) => scrubExchange(capture.file, exchange)),
  };
  const text = `${JSON.stringify(scrubbed, null, 2)}\n`;
  const decoded = scrubbed.exchanges
    .filter((exchange) => "base64" in exchange.answer.body)
    .map((exchange) => bodyBytes(exchange.answer.body).toString("latin1"));
  const hits = [...new Set([text, ...decoded].flatMap((part) => secretHits(part, secrets)))];
  if (hits.length > 0)
    throw new Error(`${capture.file}: holds the fixture secret ${hits.join(", ")}; nothing was written`);
  return text;
}
