/**
 * The sign-in latch of design 3.5: once Databend refuses a sign-in, this Studio process sends that password to that
 * server again only after 15 minutes, or after the credential changes; another replica keeps a latch of its own
 * (backlog D252).
 *
 * Databend counts failed sign-ins only for a user under a password policy, and five in 15 minutes lock that user for
 * 15 minutes, during which the right password is refused too (measured, L10). Studio retries on its own (the pulse,
 * the fleet check, a tree read and a probe sent at once on activation), and a failed `connect()` is never cached, so
 * the latch lives in the process, not in a provider: two instances on one key share it, a disconnect does not clear
 * it, and a restart does.
 *
 * The key is an HMAC-SHA-256, keyed by 32 random bytes the process draws once, over the length-framed scheme, far end,
 * bastion route, user and password [X03], so a key seen outside the process, in a heap snapshot or a log line, cannot
 * be used to test a guessed password (the pattern of src/lib/auth-compare.ts). The far end is
 * the tunnel's when an SSH tunnel carries the connection, never the local forward, which is a new port for every
 * tunnel and every Test Connection; its host is framed in one spelling, so one server written two ways is one key.
 * The warehouse is not framed, because the user is locked whatever compute is named. No secret is kept: the map holds
 * digests.
 *
 * Single flight [X14]: until a key has had an answer, one attempt holds it, from its POST to its last close. Another
 * acquire waits inside its own signal and is refused unsent if the first latches; a proven key never waits. Only an
 * answer read as one proves a key, never a refusal, whatever its status; an attempt released with neither a proof nor
 * a latch hands the key to the next waiter.
 *
 * At most 256 entries, each lasting 15 minutes: a new entry first drops every expired one, then the oldest proven
 * one, and the oldest latched one only when every entry is latched and live [X30]. A proof is never kept at the cost
 * of a latch: with every entry latched and live it is not written, and its key stays unproven.
 */
import { createHmac, randomBytes } from "node:crypto";
import { latchedError, latchesSignIn, type SignInAnswer } from "./errors";
import type { DatabendError } from "./transport";

/** How long a refusal holds its key, Databend's own lockout window (`password_policy.rs:45-46`). */
export const AUTH_LATCH_TTL_MS = 15 * 60 * 1000;
/** The most keys the latch holds. */
export const AUTH_LATCH_MAX_ENTRIES = 256;
/** What the key frames, each field as the connection options validated it. */
export interface AuthLatchIdentity {
  readonly scheme: "http" | "https";
  /** The far end: the tunnel's when one carries the connection, else the connection's own host. */
  readonly host: string;
  readonly port: number;
  /** The SSH tunnel's route as Studio hands it under `TUNNEL_ROUTE`, empty without a tunnel far end. */
  readonly route: string;
  readonly user: string;
  /** Empty when none is set, which Studio still sends as Basic (I10). */
  readonly password: string;
}

/** One attempt's hold on its key, from the statement's POST to its last close. */
export interface AuthAttempt {
  /** An answer read as one arrived: the key is proven, and every waiter proceeds. */
  prove(): void;
  /**
   * Reports a refusal, of any request and over any status: one that `latchesSignIn` of `errors.ts` names latches the
   * key, and true says so; nothing else changes it.
   */
  refuse(answer: SignInAnswer): boolean;
  /**
   * The attempt sent its last request: an unproven key goes to the next waiter, or every waiter is refused when it
   * latched. A second call does nothing.
   */
  release(): void;
}

export interface AuthLatch {
  /**
   * The hold to send under. Refused with `latchedError` of `errors.ts` while the key is latched; on an unproven key held by
   * another attempt, waits until that one settles, and is refused with the signal's reason if the signal fires first.
   */
  acquire(key: string, signal: AbortSignal): Promise<AuthAttempt>;
}

/**
 * One spelling per host: an IPv6 literal, the one validated host holding a colon, as the URL standard serialises it
 * (`0:0:0:0:0:0:0:1` is `::1`), and a DNS name without its final dot.
 */
function canonicalHost(host: string): string {
  if (host.includes(":")) return new URL(`http://[${host}]/`).hostname.slice(1, -1);
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

/** The process's key of the latch keys; the memo is load-bearing, since a new key per call would split one identity. */
let processKey: Buffer | null = null;

function latchKeyKey(): Buffer {
  if (processKey === null) processKey = randomBytes(32);
  return processKey;
}

/** The key of one identity: HMAC-SHA-256 hex over the length-framed fields, so no field slides into the next. */
export function authLatchKey(identity: AuthLatchIdentity): string {
  const { scheme, host, port, route, user, password } = identity;
  const framed = [scheme, canonicalHost(host), String(port), route, user, password].map(
    (value) => `${value.length}:${value}`,
  );
  return createHmac("sha256", latchKeyKey()).update(framed.join(""), "utf8").digest("hex");
}

interface Entry {
  readonly state: "latched" | "proven";
  readonly at: number;
}

interface Waiter {
  readonly resolve: (attempt: AuthAttempt) => void;
  readonly reject: (reason: unknown) => void;
  readonly detach: () => void;
}

export function createAuthLatch(deps: { readonly now: () => number }): AuthLatch {
  const entries = new Map<string, Entry>();
  /** The unproven keys an attempt holds, each with the acquires waiting behind it. */
  const flights = new Map<string, Waiter[]>();

  function liveEntry(key: string): Entry | undefined {
    const entry = entries.get(key);
    if (entry === undefined || !expired(entry)) return entry;
    entries.delete(key);
    return undefined;
  }

  function expired(entry: Entry): boolean {
    return deps.now() - entry.at >= AUTH_LATCH_TTL_MS;
  }

  /** The entry to evict for a write of `state`: the oldest proven one, else the oldest latched one for a latch. */
  function evictable(state: Entry["state"]): string | undefined {
    for (const [key, entry] of entries) if (entry.state === "proven") return key;
    return state === "latched" ? (entries.keys().next().value as string) : undefined;
  }

  function write(key: string, state: Entry["state"]): void {
    entries.delete(key);
    if (entries.size >= AUTH_LATCH_MAX_ENTRIES) {
      for (const [other, entry] of entries) if (expired(entry)) entries.delete(other);
    }
    if (entries.size >= AUTH_LATCH_MAX_ENTRIES) {
      const evicted = evictable(state);
      // Every entry is latched and live: a proof is not kept at the cost of a latch.
      if (evicted === undefined) return;
      entries.delete(evicted);
    }
    entries.set(key, { state, at: deps.now() });
  }

  function refusal(entry: Entry): DatabendError {
    return latchedError(new Date(entry.at), new Date(entry.at + AUTH_LATCH_TTL_MS));
  }

  /** Ends a flight: every waiter is refused on a latch and proceeds on a proof; otherwise the next one takes it. */
  function handOn(key: string): void {
    const waiters = flights.get(key) as Waiter[];
    const entry = liveEntry(key);
    if (entry === undefined) {
      const next = waiters.shift();
      if (next === undefined) {
        flights.delete(key);
        return;
      }
      next.detach();
      next.resolve(attempt(key, true));
      return;
    }
    flights.delete(key);
    for (const waiter of waiters) {
      waiter.detach();
      if (entry.state === "latched") waiter.reject(refusal(entry));
      else waiter.resolve(attempt(key, false));
    }
  }

  function attempt(key: string, holdsFlight: boolean): AuthAttempt {
    let holding = holdsFlight;
    const release = () => {
      if (!holding) return;
      holding = false;
      handOn(key);
    };
    return {
      prove() {
        // A late answer from an attempt acquired before a newer refusal never lifts that latch.
        if (liveEntry(key)?.state !== "latched") write(key, "proven");
        release();
      },
      refuse(answer) {
        if (!latchesSignIn(answer)) return false;
        write(key, "latched");
        return true;
      },
      release,
    };
  }

  return {
    async acquire(key, signal) {
      const entry = liveEntry(key);
      if (entry?.state === "latched") throw refusal(entry);
      if (entry?.state === "proven") return attempt(key, false);
      const waiters = flights.get(key);
      if (waiters === undefined) {
        flights.set(key, []);
        return attempt(key, true);
      }
      signal.throwIfAborted();
      return new Promise<AuthAttempt>((resolve, reject) => {
        const onAbort = () => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(signal.reason);
        };
        const waiter: Waiter = { resolve, reject, detach: () => signal.removeEventListener("abort", onAbort) };
        signal.addEventListener("abort", onAbort, { once: true });
        waiters.push(waiter);
      });
    },
  };
}
