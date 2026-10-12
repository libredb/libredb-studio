/**
 * What the RabbitMQ live scripts share: the pinned images, the target read from the environment, and the admin's
 * management API client the seed and the harnesses use to build and inspect the fixture.
 *
 * Every image is pinned by digest, and the expected outcome of a live check is keyed by that digest, never by a
 * version the broker reports: a development build of 4.3 reports `4.3.0+<sha>`, so a version cannot tell a build that
 * converts every AMQP 1.0 value from one that closes the connection with 541.
 * The admin client is test-only: the provider's own management client is GET-only by construction, and nothing
 * under `src/` may import this file (`tests/unit/db/rabbitmq/live-environment.test.ts`).
 */

export const RABBITMQ_436_DIGEST = "sha256:8dd6e3570ddaa2ef82a6c3a8950e79c1f73893adfbdddbc374fc1f1ac8a0f5dd";
export const RABBITMQ_429_DIGEST = "sha256:9e9fd21d60f060acc9ecbd847cd1dcb87e6550bdb0297c27e79a40bfe1766ce4";
/** The main fixture: `database-compose.yml`'s `rabbitmq` service and the CI step use this reference unchanged. */
export const RABBITMQ_FIXTURE_IMAGE = `rabbitmq:4.3.6-management@${RABBITMQ_436_DIGEST}`;
/** The permanent home of the 541 behaviour: 4.2 receives no further community release. */
export const RABBITMQ_42_IMAGE = `rabbitmq:4.2.9-management@${RABBITMQ_429_DIGEST}`;
/** A 4.3 branch build that carries the conversion fix, tag v4.3.x-nightly.20261009-otp27, for the fixed-build frames. */
export const RABBITMQ_NIGHTLY_IMAGE =
  "pivotalrabbitmq/rabbitmq@sha256:0a34c75c447856b52770f6e19cd58b0431427c263de2b89d531c686f0cdf0e50";
/** The seed one-shot's runtime, the repository's own Bun. */
export const RABBITMQ_SEED_IMAGE =
  "oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895";
/** The digests a live script accepts, with the broker version each one is. */
export const RABBITMQ_PINNED_DIGESTS: Readonly<Record<string, string>> = {
  [RABBITMQ_436_DIGEST]: "4.3.6",
  [RABBITMQ_429_DIGEST]: "4.2.9",
};

/** The variables a live script reads; `process.env` is one. */
export type LiveEnvironment = Readonly<Record<string, string | undefined>>;

export interface RabbitMQLiveTarget {
  readonly host: string;
  readonly managementPort: number;
  readonly amqpPort: number;
  readonly prometheusPort: number;
  readonly adminUser: string;
  readonly adminPassword: string;
  /** The one password of the four fixture users. */
  readonly fixturePassword: string;
  /** The image digest the broker runs, one of RABBITMQ_PINNED_DIGESTS. */
  readonly digest: string;
}

function port(env: LiveEnvironment, name: string, fallback: number): number {
  const text = env[name];
  if (text === undefined || text === "") return fallback;
  if (!/^[0-9]{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65_535) {
    throw new Error(`${name} must be a port number from 1 to 65535.`);
  }
  return Number(text);
}

function required(env: LiveEnvironment, name: string): string {
  const value = env[name];
  if (value === undefined || value === "")
    throw new Error(`${name} is not set; the RabbitMQ live scripts read it from the environment.`);
  return value;
}

/**
 * The target from `RABBITMQ_LIVE_*`: host and the three ports default to the compose service on this machine; the two
 * passwords and the digest have no default, so a run never guesses which broker or which credentials it has.
 */
export function liveTarget(env: LiveEnvironment = process.env): RabbitMQLiveTarget {
  const digest = required(env, "RABBITMQ_LIVE_DIGEST");
  if (!(digest in RABBITMQ_PINNED_DIGESTS)) {
    throw new Error(
      `RABBITMQ_LIVE_DIGEST must be one of the pinned digests: ${Object.keys(RABBITMQ_PINNED_DIGESTS).join(", ")}.`,
    );
  }
  return {
    host: env.RABBITMQ_LIVE_HOST || "127.0.0.1",
    managementPort: port(env, "RABBITMQ_LIVE_MANAGEMENT_PORT", 15672),
    amqpPort: port(env, "RABBITMQ_LIVE_AMQP_PORT", 5672),
    prometheusPort: port(env, "RABBITMQ_LIVE_PROMETHEUS_PORT", 15692),
    adminUser: env.RABBITMQ_LIVE_ADMIN_USER || "libredb-admin",
    adminPassword: required(env, "RABBITMQ_LIVE_ADMIN_PASSWORD"),
    fixturePassword: required(env, "RABBITMQ_LIVE_FIXTURE_PASSWORD"),
    digest,
  };
}

/** One management API answer as the admin client read it. */
export interface AdminAnswer {
  readonly status: number;
  readonly text: string;
}

/** The admin's management API client: every call is bounded at 30 s, and a status outside `accept` throws. */
export class AdminApi {
  constructor(
    private readonly target: RabbitMQLiveTarget,
    private readonly user = target.adminUser,
    private readonly password = target.adminPassword,
  ) {}

  /** A client for the same broker that signs in as another user. */
  as(user: string, password: string): AdminApi {
    return new AdminApi(this.target, user, password);
  }

  async call(
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    accept: readonly number[] = [200, 201, 204],
  ): Promise<AdminAnswer> {
    const response = await fetch(`http://${this.target.host}:${this.target.managementPort}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.user}:${this.password}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!accept.includes(response.status)) throw new Error(`${method} ${path} answered ${response.status}.`);
    return { status: response.status, text };
  }

  async json<T>(path: string): Promise<T> {
    return JSON.parse((await this.call("GET", path)).text) as T;
  }
}

/** A vhost or name as one management API path segment. */
export const segment = (name: string): string => encodeURIComponent(name);
