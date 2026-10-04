/**
 * TCP reachability probe for discovered CapRover services (spec section 9.6).
 *
 * Only environment-fallback candidates are probed: an image CapRover built carries a database
 * env key just as many client apps do, and a listener on the engine's port is what tells them apart.
 *
 * A success is cached per host:port for 30 seconds. A failure is never cached, so a database that
 * is still initialising is listed on the first recompute after it starts listening. Concurrent
 * checks of one host:port share one pending promise, and at most 16 sockets are open at once.
 */
import { createConnection, type Socket } from "node:net";

const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_CACHE_MS = 30_000;
const DEFAULT_CONCURRENCY = 16;

export interface ProbeOptions {
  timeoutMs?: number;
  cacheMs?: number;
  concurrency?: number;
}

/** Injectable seams: tests pin the clock and hand in sockets that never connect. */
export interface ProbeDeps {
  connect?: (port: number, host: string) => Socket;
  now?: () => number;
}

export interface Probe {
  /**
   * Resolves true when the port accepts a connection and false on a timeout or a connection error; it
   * rejects only when the connect seam throws.
   */
  check(host: string, port: number): Promise<boolean>;
  reset(): void;
}

export function createProbe(deps: ProbeDeps = {}, options: ProbeOptions = {}): Probe {
  const connect = deps.connect ?? ((port: number, host: string) => createConnection({ port, host }));
  const now = deps.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  const reachableUntil = new Map<string, number>();
  const pending = new Map<string, Promise<boolean>>();
  const waiting: Array<() => void> = [];
  let active = 0;

  function acquire(): Promise<void> {
    if (active < concurrency) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  }

  /** Hands the slot to the next waiting probe, or frees it. */
  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }

  function attempt(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect(port, host);
      const finish = (reachable: boolean): void => {
        clearTimeout(timer);
        socket.destroy();
        resolve(reachable);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      socket.once("connect", () => finish(true));
      // Stays attached after finish: an error a destroyed socket still raises is swallowed here.
      socket.on("error", () => finish(false));
    });
  }

  async function run(host: string, port: number): Promise<boolean> {
    await acquire();
    try {
      return await attempt(host, port);
    } finally {
      release();
    }
  }

  return {
    check(host: string, port: number): Promise<boolean> {
      const key = `${host}:${port}`;
      const until = reachableUntil.get(key);
      if (until !== undefined && now() < until) return Promise.resolve(true);
      const inFlight = pending.get(key);
      if (inFlight) return inFlight;
      const probe: Promise<boolean> = run(host, port)
        .then((reachable) => {
          if (reachable) reachableUntil.set(key, now() + cacheMs);
          return reachable;
        })
        .finally(() => {
          if (pending.get(key) === probe) pending.delete(key);
        });
      pending.set(key, probe);
      return probe;
    },
    reset(): void {
      reachableUntil.clear();
      pending.clear();
    },
  };
}

/**
 * The probe the discovery loader uses: 1000 ms timeout, 30 s positive cache, 16 sockets at most.
 * Left mutable on purpose: loader tests spy on its check method.
 */
export const defaultProbe: Probe = createProbe();
