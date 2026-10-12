/**
 * Every effect of the Firestore provider goes through one FirestoreSeams record: the transport factory with the lane
 * it is for, the clock, sleeps and deadlines, the environment read once, files, the home directory and the platform.
 * This is the one module of the directory that touches Node, the clock, timers or process.env, so a test hands in
 * fakes and needs no mock.module(), no real variable, no real file and no real wait.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createNodeTransport, type NodeTransport, type NodeTransportOptions } from "@/lib/db/http/node-transport";
import { ENV } from "./constants";

/** Which lane a transport serves: Firestore's API, Google's token endpoint, the metadata server, or the emulator. */
export type LaneKind = "api" | "token" | "metadata" | "emulator";

export interface FirestoreEnv {
  readonly [name: string]: string | undefined;
}

export interface FirestoreSeams {
  createTransport(options: NodeTransportOptions, lane: LaneKind): NodeTransport;
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** A signal that aborts with a TimeoutError DOMException after `ms`, as AbortSignal.timeout does. */
  timeoutSignal(ms: number): AbortSignal;
  /** The variables of FIRESTORE_ENV_NAMES, read once. */
  readonly env: FirestoreEnv;
  /** UTF-8; throws on any failure, with the runtime's errno `code`. */
  readFile(path: string): string;
  homeDir(): string;
  readonly platform: string;
}

/** The variables this provider reads, and nothing else of the environment. */
export const FIRESTORE_ENV_NAMES: readonly string[] = Object.freeze([
  ENV.emulatorHost,
  ENV.serverCredentials,
  ENV.credentialsFile,
  ENV.metadataHost,
  "APPDATA",
  "HOME",
]);

/** A frozen copy of the FIRESTORE_ENV_NAMES variables `source` sets. */
export function readFirestoreEnv(source: Readonly<Record<string, string | undefined>>): FirestoreEnv {
  const picked: Record<string, string> = {};
  for (const name of FIRESTORE_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) picked[name] = value;
  }
  return Object.freeze(picked);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The real seams, with any member `partial` names in its place; the environment is read only when not given. */
export function resolveSeams(partial: Partial<FirestoreSeams> = {}): FirestoreSeams {
  return Object.freeze({
    createTransport: partial.createTransport ?? ((options: NodeTransportOptions) => createNodeTransport(options)),
    now: partial.now ?? (() => Date.now()),
    sleep: partial.sleep ?? sleep,
    timeoutSignal: partial.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms)),
    env: partial.env ?? readFirestoreEnv(process.env),
    readFile: partial.readFile ?? ((path: string) => readFileSync(path, "utf8")),
    homeDir: partial.homeDir ?? (() => homedir()),
    platform: partial.platform ?? process.platform,
  });
}
