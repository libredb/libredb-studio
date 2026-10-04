/**
 * The version an InfluxDB server reports and the per-generation table (InfluxDB spec 3.3, 6.2; R2, I10). Pure.
 *
 * The version comes from bodies, never from a response header. A 3.x server answers `/ping` with a JSON body
 * (`product_name`, `version`), which decides alone. A 1.x or 2.x server answers `/ping` with a 204 and no body, so
 * the provider then reads `/health`, a 200 JSON body whose `version` is `1.13.1` on 1.x and `v2.9.1` on 2.x, with
 * no credential needed. When neither body is readable the generation is `unknown` and the version null: a
 * `/health` that is not a 200 or not JSON, the 401 of a 1.x server with `[http] ping-auth-enabled` included, names
 * nothing. Connecting still succeeds, and the authenticated read decides.
 *
 * The generation changes no policy. What differs between the lines is one row of `GENERATION_TRAITS`, read by the
 * providers, never an `if` on the generation; `unknown` takes the fail-closed answer of every column.
 */
import type { InfluxAnswer } from "./client";

export type InfluxGeneration = "v1" | "v2" | "v3" | "unknown";

export interface GenerationTraits {
  /** How a sentence names the line: "InfluxDB 1.x", "InfluxDB 2.x", "InfluxDB 3", "InfluxDB". */
  readonly label: string;
  /** The request-level error body this line sends. */
  readonly errorEnvelope: "error-field" | "code-message" | "error-field-or-text";
  /** `_internal`: listed, offered and runnable ("browse", 1.x monitoring), or hidden and refused. */
  readonly internalDatabase: "browse" | "hide";
  /** Whether this line serves `/api/v3/query_sql`; read only by the influxdb3 mis-pick refusal. */
  readonly servesSql: boolean;
  /** What a 403 from `/ping` means. */
  readonly pingForbidden: "resource-token" | "refused";
  /** Whether a `Token <secret>` header is read as `user:password` (the 1.x 401 sentence). */
  readonly tokenMeansUserPassword: boolean;
}

export const GENERATION_TRAITS: Readonly<Record<InfluxGeneration, GenerationTraits>> = Object.freeze({
  v1: Object.freeze({
    label: "InfluxDB 1.x",
    errorEnvelope: "error-field",
    internalDatabase: "browse",
    servesSql: false,
    pingForbidden: "refused",
    tokenMeansUserPassword: true,
  }),
  v2: Object.freeze({
    label: "InfluxDB 2.x",
    errorEnvelope: "code-message",
    internalDatabase: "hide",
    servesSql: false,
    pingForbidden: "refused",
    tokenMeansUserPassword: false,
  }),
  v3: Object.freeze({
    label: "InfluxDB 3",
    errorEnvelope: "error-field-or-text",
    internalDatabase: "hide",
    servesSql: true,
    pingForbidden: "resource-token",
    tokenMeansUserPassword: false,
  }),
  unknown: Object.freeze({
    label: "InfluxDB",
    errorEnvelope: "error-field-or-text",
    internalDatabase: "hide",
    servesSql: false,
    pingForbidden: "refused",
    tokenMeansUserPassword: false,
  }),
});

export interface InfluxServerVersion {
  readonly generation: InfluxGeneration;
  /** The version as reported when it matches /^v?\d{1,4}(\.\d{1,6}){1,3}([-+][0-9A-Za-z.]{1,24})?$/; null otherwise. */
  readonly reported: string | null;
  /** `Core` or `Enterprise` when the 3.x `/ping` body's `product_name` is exactly "InfluxDB 3 Core" or "InfluxDB 3 Enterprise"; null otherwise (1.x and 2.x name no build in a body). */
  readonly build: string | null;
}

/** A version short and plain enough to repeat in a sentence, with its major captured: never a server's free text. */
const REPORTED = /^v?(\d{1,4})(?:\.\d{1,6}){1,3}(?:[-+][0-9A-Za-z.]{1,24})?$/;

const GENERATION_BY_MAJOR: ReadonlyMap<number, InfluxGeneration> = new Map([
  [1, "v1"],
  [2, "v2"],
  [3, "v3"],
]);

const BUILD_BY_PRODUCT_NAME: ReadonlyMap<unknown, string> = new Map([
  ["InfluxDB 3 Core", "Core"],
  ["InfluxDB 3 Enterprise", "Enterprise"],
]);

const UNKNOWN: InfluxServerVersion = Object.freeze({ generation: "unknown", reported: null, build: null });

type Body = Pick<InfluxAnswer, "status" | "text">;

/** The JSON object of a 200 answer; undefined for another status, text that is not JSON, or JSON that is no object. */
function jsonObject(answer: Body | undefined): Readonly<Record<string, unknown>> | undefined {
  if (answer?.status !== 200) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.text);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Readonly<Record<string, unknown>>)
    : undefined;
}

/** True when `/ping` answered 200 or 204 with an empty body, so `/health` must be read (spec 3.3, 6.2). */
export function pingNeedsHealth(ping: Body): boolean {
  return (ping.status === 200 || ping.status === 204) && ping.text.trim() === "";
}

/**
 * R2: the version from bodies, never from response headers.
 * `ping` is the `/ping` answer: a 200 with a JSON body (3.x: `product_name`, `version`) decides alone.
 * When `/ping` answered with no body (1.x and 2.x answer 204), `health` is the `/health` answer: a 200 JSON body
 * whose `version` field is read (1.x `1.13.1`, 2.x `v2.9.1`, no credentials needed).
 * Neither body readable: generation `unknown`, version null. A `/health` 401, which a 1.x server with
 * `[http] ping-auth-enabled` answers, is "not readable" too: generation `unknown`, never the 1.x 401 sentence.
 *
 * A reported major of 1 is `v1`, 2 is `v2`, 3 is `v3`, anything else or nothing is `unknown`. A build is named
 * only by a `/ping` body, and only beside a version of generation `v3`.
 */
export function readPing(ping: Body, health?: Body): InfluxServerVersion {
  const fromHealth = pingNeedsHealth(ping);
  const body = jsonObject(fromHealth ? health : ping);
  const version = body?.version;
  const major = typeof version === "string" ? REPORTED.exec(version)?.[1] : undefined;
  if (major === undefined) return UNKNOWN;
  const generation = GENERATION_BY_MAJOR.get(Number(major)) ?? "unknown";
  const build = fromHealth || generation !== "v3" ? undefined : BUILD_BY_PRODUCT_NAME.get(body?.product_name);
  return { generation, reported: version as string, build: build ?? null };
}
