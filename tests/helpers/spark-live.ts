/**
 * What the hand-run Spark tools share (tests/live/spark-evidence.ts and tests/live/spark-live-check.ts): the reading
 * of their environment, refused with exit code 2 before any socket, and the mask every line they
 * print passes. Every input comes from the environment, never from a file of this repository. A refusal names the
 * variable and never its value, since the value may be a secret. Every target and driver UI must be a loopback
 * address: the tools reach only the compose fixture started on this machine.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { secretForms } from "@/lib/db/utils/server-text";

export type SparkLiveService = "spark" | "spark-4-1" | "spark-auth" | "spark-tls";

export interface SparkLiveArguments {
  readonly token: string;
  /** The directory docker/spark/make-certs.sh wrote: ca.pem, server.pem, server.key, outside the repository. */
  readonly tlsDir: string;
  readonly targets: Readonly<Record<SparkLiveService, { readonly host: string; readonly port: number }>>;
  readonly driverUi: Readonly<Record<"spark" | "spark-4-1", string>>;
}

export interface SparkLiveRefusal {
  readonly exitCode: 2;
  readonly message: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TOKEN = /^[A-Za-z0-9._~+/=-]{16,256}$/;
const LOOPBACK_TARGET = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/;
const LOOPBACK_UI = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/;
const TARGETS: readonly (readonly [SparkLiveService, string, string])[] = [
  ["spark", "SPARK_LIVE_TARGET", "127.0.0.1:15002"],
  ["spark-4-1", "SPARK_LIVE_TARGET_41", "127.0.0.1:15003"],
  ["spark-auth", "SPARK_LIVE_TARGET_AUTH", "127.0.0.1:15004"],
  ["spark-tls", "SPARK_LIVE_TARGET_TLS", "127.0.0.1:15005"],
];
const MASK = "<masked>";

class Refused extends Error {}

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") throw new Refused(`${name} is not set; nothing was sent.`);
  return value;
}

function port(text: string): number | undefined {
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : undefined;
}

function target(env: Environment, name: string, example: string): { readonly host: string; readonly port: number } {
  const match = LOOPBACK_TARGET.exec(required(env, name));
  const number = match === null ? undefined : port(match[2] as string);
  if (match === null || number === undefined) {
    throw new Refused(`${name} must be a loopback host and port such as ${example}; nothing was sent.`);
  }
  const host = (match[1] as string).replace(/^\[|\]$/g, "");
  return { host, port: number };
}

function driverUi(env: Environment, name: string, example: string): string {
  const value = required(env, name);
  const match = LOOPBACK_UI.exec(value);
  if (match === null || port(match[2] as string) === undefined) {
    throw new Refused(
      `${name} must be http:// on a loopback host and port with no path, such as ${example}; nothing was sent.`,
    );
  }
  return value;
}

function tlsDirectory(env: Environment): string {
  const dir = required(env, "SPARK_TLS_DIR");
  const relative = path.relative(ROOT, dir);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  const complete = ["ca.pem", "server.pem", "server.key"].every((file) => existsSync(path.join(dir, file)));
  if (!path.isAbsolute(dir) || inside || !existsSync(dir) || !statSync(dir).isDirectory() || !complete) {
    throw new Refused(
      "SPARK_TLS_DIR must be an absolute directory outside the repository that holds ca.pem, server.pem and server.key; nothing was sent.",
    );
  }
  return dir;
}

export function readSparkLiveArguments(env: Environment): SparkLiveArguments | SparkLiveRefusal {
  try {
    required(env, "SPARK_CONNECT_TOKEN");
    // The untrimmed value: a token that ends in a newline or a space is refused, not silently trimmed.
    const token = env.SPARK_CONNECT_TOKEN as string;
    if (!TOKEN.test(token)) {
      throw new Refused(
        "SPARK_CONNECT_TOKEN must be 16 to 256 letters, digits or the characters . _ ~ + / = -; nothing was sent.",
      );
    }
    const tlsDir = tlsDirectory(env);
    const targets = Object.fromEntries(
      TARGETS.map(([service, name, example]) => [service, target(env, name, example)]),
    ) as Record<SparkLiveService, { readonly host: string; readonly port: number }>;
    return {
      token,
      tlsDir,
      targets,
      driverUi: {
        spark: driverUi(env, "SPARK_LIVE_UI", "http://127.0.0.1:4040"),
        "spark-4-1": driverUi(env, "SPARK_LIVE_UI_41", "http://127.0.0.1:4041"),
      },
    };
  } catch (error) {
    if (error instanceof Refused) return { exitCode: 2, message: error.message };
    throw error;
  }
}

/** The token's forms (the token, its base64, its URI form), which no printed line may carry. */
export function sparkLiveSecrets(args: SparkLiveArguments): string[] {
  return [...secretForms([args.token])];
}

/** `text` with every non-empty secret replaced by `<masked>`, the longest first so a form inside another is not left. */
export function maskSparkLive(text: string, secrets: readonly string[]): string {
  return [...secrets]
    .filter((secret) => secret !== "")
    .sort((a, b) => b.length - a.length)
    .reduce((masked, secret) => masked.split(secret).join(MASK), text);
}
