/**
 * One request in flight per endpoint, each with its own timer, and a redial after any doubt.
 *
 * WHY EVERY REQUEST CARRIES ITS OWN TIMER AND THE TIMER IS NOT OPTIONAL. MEASURED by us on
 * 13 October 2026 under Node 24 and Bun 1, against a device made to vanish without sending FIN or
 * RST (packets dropped with the interface left in place): with `setTimeout(3000)` the read ended at
 * 3005 ms under Node and 3029 ms under Bun; with no timer nothing happened for 143995 ms. The
 * kernel's own bound is `tcp_retries2 = 15`, which is roughly fifteen minutes. So a read without a
 * timer does not fail slowly, it does not fail at all on any timescale a user waits through.
 *
 * WHY THE SOCKET STATE IS NEVER CONSULTED. Same measurement: in all four runs the socket read as
 * ESTABLISHED on our side while no answer was coming. A health check that asked the socket would
 * have called a dead device healthy. Health is decided by an answer or the absence of one, never by
 * a connection's state.
 *
 * WHY A TIMEOUT'S WORDING COMES FROM OUR TIMER AND NEVER FROM `err.code`. Same measurement: in the
 * no timer run no error ever arrived, so for 144 seconds there was no code to read. A sentence
 * built from `err.code` cannot be written in the case that most needs one.
 *
 * WHY ONE REQUEST IN FLIGHT. MEASURED by the issue author: with up to 32 reads sent at once on one
 * connection, the pymodbus device server answered at most 3 of 32 and the simulator none, the rest
 * timing out, and it sent no exception 06 to say it was busy. And a read abandoned after 1 s was
 * answered later with the NEXT request's transaction id, because the server read its last PDU after
 * the delay. A client that pipelines therefore cannot tell whose answer it is holding.
 */
import { MAX_TRANSACTIONS_IN_FLIGHT, REQUEST_TIMEOUT_MS } from "./constants";
import type { Exchange } from "./framing";

export class ModbusTimeout extends Error {
  readonly kind = "timeout" as const;
  constructor(public readonly elapsedMs: number) {
    super(
      `The device did not answer within ${elapsedMs} ms. The connection looked open the whole time: a Modbus TCP socket stays established when a device loses power, so a read is only ever ended by this timer.`,
    );
  }
}

export interface Wire {
  /**
   * Sends one ADU and resolves with what that exchange ENDED as, or rejects. Never queues
   * internally.
   *
   * The answer crosses this seam already parsed, not as bytes: the frame reader has read the
   * header to know where the frame ends, so handing bytes on would mean reading the same header
   * a second time somewhere else, and two readings of one header is one reading too many.
   */
  exchange(adu: Buffer, signal: { aborted: boolean }): Promise<Exchange>;
  close(reason: string): void;
}

export interface SessionOptions {
  readonly requestTimeoutMs?: number;
  /** Minimum gap between requests to one endpoint. A gateway's serial line pays per request. */
  readonly minIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Serialises every exchange to one endpoint and gives each one its own timer. Transaction ids are
 * handed out once and never reused on a connection, so a late answer can be recognised as late
 * rather than mistaken for the current one (TCP 4.4.1.3).
 */
export class ModbusSession {
  private queue: Promise<unknown> = Promise.resolve();
  private nextTransactionId = 1;
  private inFlight = 0;
  private lastFinishedAt = 0;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly wire: Wire,
    options: SessionOptions = {},
  ) {
    this.timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Transaction ids are never reused on one connection; it wraps at 16 bits by the protocol. */
  takeTransactionId(): number {
    const id = this.nextTransactionId;
    this.nextTransactionId = (this.nextTransactionId % 0xffff) + 1;
    return id;
  }

  /**
   * Runs one exchange. Resolves with the answer, or rejects. A rejection always closes the
   * connection first: after a timeout, a malformed frame or an answer for another unit there is no
   * state in which continuing on the same socket is safe, because the next answer to arrive may
   * belong to the request we just gave up on.
   */
  async exchange(build: (transactionId: number) => Buffer): Promise<Exchange> {
    const run = this.queue.then(async () => {
      if (this.inFlight >= MAX_TRANSACTIONS_IN_FLIGHT)
        throw new Error("A second request reached the session while one was in flight.");

      const since = this.now() - this.lastFinishedAt;
      if (this.minIntervalMs > 0 && this.lastFinishedAt > 0 && since < this.minIntervalMs)
        await this.sleep(this.minIntervalMs - since);

      const adu = build(this.takeTransactionId());
      this.inFlight += 1;
      const started = this.now();
      const signal = { aborted: false };
      try {
        return await this.withTimeout(this.wire.exchange(adu, signal), started, signal);
      } catch (error) {
        this.wire.close(error instanceof ModbusTimeout ? "request timed out" : "request failed");
        throw error;
      } finally {
        this.inFlight -= 1;
        this.lastFinishedAt = this.now();
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private withTimeout(work: Promise<Exchange>, started: number, signal: { aborted: boolean }): Promise<Exchange> {
    return new Promise<Exchange>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal.aborted = true;
        reject(new ModbusTimeout(this.now() - started));
      }, this.timeoutMs);
      work.then(
        (value) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(value);
          }
        },
        (error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error);
          }
        },
      );
    });
  }
}
