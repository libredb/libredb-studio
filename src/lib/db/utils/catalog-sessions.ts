/**
 * The per-catalog sessions one server-level connection keeps open (#1530): at most `limit`, the idle
 * one used least recently closed to make room, and never one still at work or just handed out.
 */
export interface CatalogSessionHost<P> {
  open(name: string): Promise<P>;
  close(session: P): Promise<void>;
  isBusy(session: P): boolean;
  /** Thrown when every open session is busy and another is asked for. */
  exhausted(open: readonly string[]): Error;
}

export interface CatalogSessionLimits {
  readonly limit: number;
  /** How long after a hand-out a session counts as busy, before it has borrowed a client. */
  readonly leaseGraceMs: number;
}

export class CatalogSessions<P> {
  /** Least recently used first: a `Map` iterates in insertion order. */
  private readonly sessions = new Map<string, P>();
  private readonly opening = new Map<string, Promise<P>>();
  private readonly leasedAt = new Map<string, number>();

  constructor(
    private readonly host: CatalogSessionHost<P>,
    private readonly limits: CatalogSessionLimits,
    private readonly now: () => number = () => Date.now(),
  ) {}

  public async acquire(name: string): Promise<P> {
    const open = this.sessions.get(name);
    if (open !== undefined) {
      this.sessions.delete(name);
      this.sessions.set(name, open);
      this.leasedAt.set(name, this.now());
      return open;
    }
    const pending = this.opening.get(name);
    if (pending !== undefined) return pending;

    // Chosen before the first await, so two catalogs opened at once cannot both see room.
    const evicted = this.evictOne();
    const opened = (async () => {
      if (evicted !== undefined) await this.host.close(evicted);
      const session = await this.host.open(name);
      this.sessions.set(name, session);
      this.leasedAt.set(name, this.now());
      return session;
    })();
    this.opening.set(name, opened);
    return opened.finally(() => this.opening.delete(name));
  }

  public find(match: (session: P) => boolean): P | undefined {
    return [...this.sessions.values()].find(match);
  }

  /** Closes every session, including the ones still opening. */
  public async closeAll(): Promise<void> {
    await Promise.allSettled([...this.opening.values()]);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.leasedAt.clear();
    await Promise.all(sessions.map((session) => this.host.close(session)));
  }

  private evictOne(): P | undefined {
    if (this.sessions.size + this.opening.size < this.limits.limit) return undefined;
    const idle = [...this.sessions].find(([name, session]) => !this.isBusy(name, session));
    if (idle === undefined) {
      throw this.host.exhausted([...this.sessions.keys(), ...this.opening.keys()]);
    }
    const [name, session] = idle;
    this.sessions.delete(name);
    this.leasedAt.delete(name);
    return session;
  }

  private isBusy(name: string, session: P): boolean {
    const leased = this.leasedAt.get(name) ?? 0;
    return this.now() - leased < this.limits.leaseGraceMs || this.host.isBusy(session);
  }
}
