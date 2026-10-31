/**
 * The pacing of agent reads on one Modbus device: one at a time across every run and connection of this server
 * process, with a fixed gap after each.
 *
 * WHY. A device that serves one client at a time (a libmodbus server written to its documented pattern, and many
 * gateways and controllers) answers nobody else while a client holds its connection. MEASURED on the single-client
 * capture device (`tests/fixtures/modbus/2.3.0/agent-boundary/`): a second client sent a read while the first held
 * its connection for 2000 ms was answered only when the first closed, 0 ms after it, and a client that dialled after a
 * read closed was answered in 0 to 1 ms. So the lockout is the hold and nothing after it, and the plant's own HMI or
 * SCADA reaches the device only between reads. Agent reads therefore never overlap on one device, and a fixed gap,
 * `MODBUS_AGENT_DEVICE_GAP_MS`, follows each one, measured from the moment its socket was destroyed, so the next agent
 * read cannot queue straight behind the last and leave the plant's client no turn. One agent read held the
 * single-client device's connection for 1 ms in the capture (`agentReadHoldMs`: dial, one read, close), so the gap
 * leaves a device that serves one client at a time free for all but about a thousandth of the time an agent spends on
 * it, even when a run reads it back to back.
 *
 * WHAT A LANE IS KEYED BY. The device's address, host and port, and not the unit: a gateway serves every unit behind it
 * over one connection, so two reads to two units of one gateway contend for the same single client. A host written two
 * ways (a name and its address) is two lanes; the provider doc records that residual.
 *
 * WHY HERE AND NOT ON THE PROVIDER. Providers are cached and shared per connection and profile, and two connections may
 * name one device, so a queue on the provider would let two of them overlap. Nor in a module-level value alone: Next.js
 * loads this module more than once in one server process (instrumentation, which resumes agent runs, is bundled apart
 * from the route handlers, as `src/lib/db/owner-removal.ts` records), and each copy would keep lanes of its own. So the
 * process's lanes are kept in a global under a registered symbol, and every copy's pacer reads and writes that one map.
 *
 * A wait counts against the read's own deadline: a read whose turn would come after it is refused before anything is
 * sent, and it keeps its place in the order until the read ahead of it ends, so a refused waiter never lets the read
 * behind it overlap the one in front. Every lane is released in `finally`, so a read that fails, or is abandoned by its
 * caller, holds a lane no longer than its own deadline, which bounds its socket too.
 */

/**
 * The gap after one agent read before the next agent read of the same device dials, in milliseconds. A fixed value
 * chosen to leave the plant's client a turn, not a measured one: the module comment records the measurement behind it.
 */
export const MODBUS_AGENT_DEVICE_GAP_MS = 1000;

/** A read whose turn on the device would come after its deadline. Raised before anything is sent. */
export class ModbusPacingTimeout extends Error {
  constructor(public readonly waitedMs: number) {
    super(`A Modbus agent read waited ${waitedMs} ms for its turn on the device.`);
    this.name = "ModbusPacingTimeout";
  }
}

interface Lane {
  /** Settles when every read queued on this lane so far has ended. */
  tail: Promise<void>;
  /** When the last read that reached the device destroyed its socket, on `now`'s clock. */
  closedAt: number | undefined;
  /** Reads queued or running on this lane. */
  holders: number;
}

interface PacingClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const REAL_CLOCK: PacingClock = {
  now: () => performance.now(),
  // Timers count whole milliseconds; rounding up keeps a gap from ending before the moment it waits for.
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.ceil(ms))),
};

/** The key of a device's lane: its address. A host name is compared without case, as DNS compares it. */
export function deviceKey(host: string, port: number): string {
  return `${host.toLowerCase()}|${port}`;
}

const LANES_KEY = Symbol.for("libredb-studio.modbus-agent-lanes");

type LanesHolder = { [LANES_KEY]?: Map<string, Lane> };

/** The lanes of this server process, one map however many copies of this module the process loaded. */
function processLanes(): Map<string, Lane> {
  const holder = globalThis as LanesHolder;
  holder[LANES_KEY] ??= new Map();
  return holder[LANES_KEY];
}

export class ModbusDevicePacer {
  /**
   * `lanes` is the map this pacer queues on: the process's own for the pacer every agent read goes through, a map of
   * its own for any other.
   */
  constructor(
    private readonly gapMs: number = MODBUS_AGENT_DEVICE_GAP_MS,
    private readonly clock: PacingClock = REAL_CLOCK,
    private readonly lanes: Map<string, Lane> = new Map(),
  ) {}

  /** How many devices hold a lane now. For the tests that hold that an idle lane is dropped. */
  get laneCount(): number {
    return this.lanes.size;
  }

  /**
   * Runs `work` on `key`'s lane once every read queued before it has ended and the gap after the last one has passed,
   * or refuses with `ModbusPacingTimeout` when that would come after `deadlineAt` (on the clock's `now`). `work` is
   * the read's whole use of the device, its socket destroyed before it settles.
   */
  async run<T>(key: string, deadlineAt: number, work: () => Promise<T>): Promise<T> {
    this.sweep();
    const startedAt = this.clock.now();
    const lane = this.lanes.get(key) ?? { tail: Promise.resolve(), closedAt: undefined, holders: 0 };
    this.lanes.set(key, lane);
    const ahead = lane.tail;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    lane.tail = ahead.then(() => mine);
    lane.holders += 1;
    try {
      await this.waitFor(ahead, deadlineAt, startedAt);
      const since = lane.closedAt === undefined ? Number.POSITIVE_INFINITY : this.clock.now() - lane.closedAt;
      if (since < this.gapMs) {
        const rest = this.gapMs - since;
        if (this.clock.now() + rest >= deadlineAt) throw new ModbusPacingTimeout(this.waited(startedAt, deadlineAt));
        await this.clock.sleep(rest);
      }
      try {
        return await work();
      } finally {
        lane.closedAt = this.clock.now();
      }
    } finally {
      lane.holders -= 1;
      // In order: a waiter refused before its turn releases only once the read ahead of it has ended.
      void ahead.then(release);
    }
  }

  /** Waits for `ahead`, or refuses at `deadlineAt`. */
  private async waitFor(ahead: Promise<void>, deadlineAt: number, startedAt: number): Promise<void> {
    const left = deadlineAt - this.clock.now();
    if (left <= 0) throw new ModbusPacingTimeout(this.waited(startedAt, deadlineAt));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => {
        // Fired, so there is nothing left to clear.
        timer = undefined;
        resolve("expired");
      }, Math.ceil(left));
    });
    try {
      const outcome = await Promise.race([ahead.then(() => "turn" as const), expired]);
      if (outcome === "expired") throw new ModbusPacingTimeout(this.waited(startedAt, deadlineAt));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private waited(startedAt: number, deadlineAt: number): number {
    return Math.max(0, Math.round(Math.min(this.clock.now(), deadlineAt) - startedAt));
  }

  /** Drops every lane nobody holds whose gap has passed, so the map holds only devices read recently. */
  private sweep(): void {
    const now = this.clock.now();
    for (const [key, lane] of this.lanes) {
      if (lane.holders === 0 && (lane.closedAt === undefined || now - lane.closedAt >= this.gapMs)) {
        this.lanes.delete(key);
      }
    }
  }
}

/**
 * The pacer every agent read of every Modbus connection goes through. Each copy of this module has one, and all of them
 * queue on the process's one set of lanes.
 */
export const MODBUS_AGENT_PACER = new ModbusDevicePacer(MODBUS_AGENT_DEVICE_GAP_MS, REAL_CLOCK, processLanes());
