/**
 * Replays what Redis 8.10.2 and Valkey 9.1.2 answered each agent principal, from the captures under
 * tests/fixtures/redis/<version>/agent-boundary/, so the Redis agent tests read the servers' own answers rather than
 * answers written for them.
 */
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { RedisReply, RedisRoundTrip } from "@/lib/db/providers/keyvalue/redis-read-only-proof";

export const REDIS_CAPTURE_VERSIONS = ["8.10.2", "valkey-9.1.2"] as const;
export type RedisCaptureVersion = (typeof REDIS_CAPTURE_VERSIONS)[number];

const FIXTURES = posix.join(import.meta.dir.replaceAll("\\", "/"), "../fixtures/redis");

/** One captured command: its argv and what the server answered. */
export interface CapturedStep {
  readonly argv: readonly string[];
  readonly outcome: "ok" | "error";
  readonly reply?: unknown;
  readonly error?: string;
}

export function readRedisCapture<T>(version: RedisCaptureVersion, name: string): T {
  return JSON.parse(readFileSync(posix.join(FIXTURES, version, "agent-boundary", `${name}.json`), "utf8")) as T;
}

interface PrincipalCapture {
  readonly probes: readonly CapturedStep[];
  readonly table: readonly CapturedStep[];
  readonly outside: readonly CapturedStep[];
}

export function principalCapture(version: RedisCaptureVersion, principal: string): PrincipalCapture {
  return readRedisCapture<PrincipalCapture>(version, principal);
}

export function asReply(step: CapturedStep): RedisReply {
  return step.outcome === "ok" ? { ok: true, reply: step.reply } : { ok: false, error: step.error ?? "" };
}

/**
 * A probe's identity across runs: its command words, since the key, channel, parameter and library it names are fresh
 * for every proof. `CONFIG SET` and `FUNCTION DELETE` are two words; every other probe is one.
 */
export function probeLabel(argv: readonly string[]): string {
  const first = argv[0].toUpperCase();
  return first === "CONFIG" || first === "FUNCTION" ? `${first} ${argv[1].toUpperCase()}` : first;
}

/** The step of `steps` whose argv is `argv` word for word, or undefined. */
export function stepFor(steps: readonly CapturedStep[], argv: readonly string[]): CapturedStep | undefined {
  return steps.find((step) => JSON.stringify(step.argv) === JSON.stringify(argv));
}

/**
 * A round trip that answers `HELLO 2` and each probe as the capture's principal was answered. `probes` overrides the
 * capture's probe answers (the mid-run grant's second pass), and `hello` its `HELLO 2`.
 */
export function capturedRoundTrip(
  version: RedisCaptureVersion,
  principal: string,
  overrides: { probes?: readonly CapturedStep[]; hello?: RedisReply } = {},
): RedisRoundTrip & { readonly sent: (readonly string[])[][] } {
  const capture = principal === "midrun" ? undefined : principalCapture(version, principal);
  const probes = overrides.probes ?? capture?.probes ?? [];
  const helloStep = stepFor((capture ?? principalCapture(version, "reader-info")).outside, ["HELLO", "2"]);
  const sent: (readonly string[])[][] = [];
  const roundTrip = async (commands: readonly (readonly string[])[]): Promise<readonly RedisReply[]> => {
    sent.push([...commands]);
    return commands.map((argv) => {
      if (argv[0] === "HELLO") return overrides.hello ?? asReply(helloStep as CapturedStep);
      const step = probes.find((probe) => probeLabel(probe.argv) === probeLabel(argv));
      if (step === undefined) throw new Error(`no captured probe for ${argv.join(" ")}`);
      return asReply(step);
    });
  };
  return Object.assign(roundTrip, { sent });
}
