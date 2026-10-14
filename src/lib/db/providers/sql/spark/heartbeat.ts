/**
 * The 15 s unary heartbeat. Spark cuts a connection with a too_many_pings GOAWAY once it has written
 * nothing on it for 20 to 40 s while the channel pings every 10 s, and a session can silence a
 * run's progress or a paused reader can silence the server; a unary call every 15 s on the same channel prevented every
 * measured cut. Each session with at least one open ExecutePlan holds one timer; each tick sends the
 * beat the caller gave (a Config get_option of spark.sql.ansi.enabled on that session, under its own deadline). A beat
 * that fails ends nothing: the run's own call reports its own outcome. The channel's options do not change.
 */
import { SPARK_HEARTBEAT_INTERVAL_MS } from "./constants";
import type { SparkSessionRef } from "./requests";

interface Hold {
  count: number;
  readonly timer: ReturnType<typeof setInterval>;
}

export class SparkHeartbeat {
  private readonly holds = new Map<string, Hold>();
  private sent = 0;

  constructor(
    private readonly beat: (session: SparkSessionRef) => Promise<void>,
    private readonly intervalMs: number = SPARK_HEARTBEAT_INTERVAL_MS,
    private readonly timers: Pick<typeof globalThis, "setInterval" | "clearInterval"> = globalThis,
  ) {}

  /**
   * Holds `session`'s timer until the returned function is called; a second call of it does nothing. Holds on one
   * sessionId share one timer, which beats with the session object the first of them passed.
   */
  hold(session: SparkSessionRef): () => void {
    const key = session.sessionId;
    let hold = this.holds.get(key);
    if (hold === undefined) {
      const timer = this.timers.setInterval(() => this.tick(session), this.intervalMs);
      hold = { count: 0, timer };
      this.holds.set(key, hold);
    }
    // The returned function counts down the hold this call counted up, which stays in the map until its count is 0.
    const counted = hold;
    counted.count += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      counted.count -= 1;
      if (counted.count === 0) {
        this.timers.clearInterval(counted.timer);
        this.holds.delete(key);
      }
    };
  }

  /** Beats sent so far, failed ones included. */
  beatsSent(): number {
    return this.sent;
  }

  private tick(session: SparkSessionRef): void {
    this.sent += 1;
    // A failed beat ends nothing: the run's own call reports its own outcome.
    Promise.resolve()
      .then(() => this.beat(session))
      .catch(() => undefined);
  }
}
