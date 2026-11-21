/**
 * One session per connection, reused (#1677 O-S6).
 *
 * A SERVER'S SESSION TABLE IS SHARED WITH THE PLANT. Measured: OPC PLC allows 100 sessions by
 * default and three of ours read back as CurrentSessionCount 3, so a provider that opened one
 * session per request would compete with the SCADA clients the plant actually runs on. The
 * in-process server's default is 10, which makes the failure mode cheap to test.
 *
 * AND STUDIO LEAVES NOTHING BEHIND. Every session this opens is closed, on every path out including
 * every failure, which is the half of O-S6 a test can assert by reading CurrentSessionCount before
 * and after a run. That reading is not portable, though: OPC PLC and open62541 answer `i=2277`,
 * asyncua answers Good with an empty Variant, and Milo answers BadNotReadable even to an
 * authenticated session. So the live check reports the count as unavailable where it cannot be
 * read, and never as zero.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { OPCUA_TYPE } from "./constants";
import type { OpcuaReadOnlyClient } from "./client";
import { isStaleSession, messageOf, OpcuaUnansweredError } from "./errors";

/** How a session is opened, so a test substitutes its own without touching the pool's rules. */
export type OpcuaSessionFactory = () => Promise<OpcuaReadOnlyClient>;

/**
 * The one session a connection holds.
 *
 * Opening is serialised: two reads arriving together share one session rather than racing to open
 * two, which is the mistake that fills a server's table fastest.
 */
export class OpcuaSessionPool {
  private client: OpcuaReadOnlyClient | undefined;
  private opening: Promise<OpcuaReadOnlyClient> | undefined;
  private closed = false;
  /** True only while a stale session is being replaced; `isOpen` reads it. */
  private replacing = false;

  public constructor(private readonly open: OpcuaSessionFactory) {}

  /** The session, opened once. */
  public async acquire(): Promise<OpcuaReadOnlyClient> {
    // A TYPED REFUSAL, because the alternative is an HTTP 500. A bare Error here was classified as
    // internal by the route's mapper, so pressing a key after Disconnect answered
    // `500 INTERNAL_ERROR` with a sentence naming no action, while every other refusal this
    // provider writes is a 400 that says what to do.
    if (this.closed)
      throw new DatabaseConfigError(
        "This OPC UA connection is closed. Connect it again to read from the server.",
        OPCUA_TYPE,
      );
    if (this.client !== undefined) return this.client;
    // A second caller arriving while the first is still opening waits for the same session.
    this.opening ??= this.open().then(
      (client) => {
        this.opening = undefined;
        // A connection closed while the session was opening must not leave it behind.
        if (this.closed) {
          void client.close().catch(() => undefined);
          throw new DatabaseConfigError(
            "This OPC UA connection was closed while its session was opening. Connect it again to read from the server.",
            OPCUA_TYPE,
          );
        }
        this.client = client;
        return client;
      },
      (error) => {
        this.opening = undefined;
        throw error;
      },
    );
    return this.opening;
  }

  /**
   * One read, on the session, run again on a NEW session if the old one turned out to be gone.
   *
   * THE ERROR TEXT PROMISED THIS AND NOTHING DELIVERED IT. `errors.ts` tells a reader that after
   * BadSessionIdInvalid "reading again opens a new one", and measured against a server whose
   * session had gone, three reads in a row answered the same code: the pool held the dead client
   * for ever, `isOpen()` kept answering true so `isConnected()` did too, the factory kept handing
   * the dead provider back, and the only eviction was 30 minutes of idleness - which a reader who
   * keeps clicking never reaches. The connection was unusable until Studio restarted.
   *
   * RETRYING IS SAFE HERE BECAUSE EVERY OPERATION IS A READ. The seam (O-S1) admits eight services
   * and none of them writes, so running one twice has no effect a server can keep. It is retried
   * ONCE: a second stale answer is the server refusing a fresh session, which is a fact to report
   * rather than a loop to spin in.
   */
  public async withSession<T>(
    // Named `run` and not `use`: the repository's react-hooks lint rule reads a call to anything
    // named `use(...)` as React's `use` hook and refuses it inside a try/catch.
    run: (client: OpcuaReadOnlyClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.acquire();
    try {
      return await run(client);
    } catch (error) {
      // Before the stale check, and outside the try: a replacement that cannot be opened is reported as it is, never
      // read as a stale session and answered by opening another.
      if (error instanceof OpcuaUnansweredError) return await this.replaceUnanswered(client, error);
      if (!isStaleSession(error)) throw error;
      /*
       * THE CONNECTION STAYS OPEN WHILE ITS SESSION IS REPLACED. `invalidate` clears the held
       * client, so for the length of the close and the reopen `isOpen()` answered false - and
       * `isConnected()` is derived from it. Measured: a second request arriving in that window was
       * handed a SECOND provider by `getOrCreateProvider` (factory.ts reads `isConnected()` to
       * decide), which opened a second session, and the first provider was dropped from the cache
       * with its own fresh session still up: a leak on the server's session table, which is the one
       * thing O-S6 exists to prevent. The flag is what keeps the window invisible from outside.
       */
      this.replacing = true;
      let retry: OpcuaReadOnlyClient | undefined;
      try {
        await this.invalidate(client);
        retry = await this.acquire();
        return await run(retry);
      } catch (retryError) {
        if (retry !== undefined && retryError instanceof OpcuaUnansweredError)
          return await this.replaceUnanswered(retry, retryError);
        throw retryError;
      } finally {
        this.replacing = false;
      }
    }
  }

  /**
   * Replace a session whose request went unanswered, then report that request's failure.
   *
   * A SESSION WHOSE CHANNEL BROKE IS REPLACED. A secure channel can break in a way the library does not report, and an
   * unanswered request is the only sign that reaches here, so the session that carried it is closed (`library.ts`
   * sends its CloseSession without waiting for the answer) and a new one opened, and only then is the failure
   * reported. An answer slower than the library's transaction timeout is the same fact from here, so it costs a
   * replacement too. The request itself is NOT run again: it already waited out a timeout, and the reader is told so.
   * A new session that cannot be opened is reported in its own words instead, and the pool then holds none.
   */
  private async replaceUnanswered(client: OpcuaReadOnlyClient, error: OpcuaUnansweredError): Promise<never> {
    // Open throughout, as in the stale-session swap: the connection is between two sessions.
    this.replacing = true;
    try {
      await this.invalidate(client);
      await this.acquire();
    } finally {
      this.replacing = false;
    }
    throw error;
  }

  /**
   * Drop a session that is gone, so the next `acquire` opens one.
   *
   * The client is named rather than assumed: two reads can fail on the same stale session at once,
   * and the second must not drop the fresh session the first already opened. Closing it is
   * best-effort - the server has already forgotten it, which is why we are here.
   */
  public async invalidate(client: OpcuaReadOnlyClient): Promise<void> {
    if (this.client !== client) return;
    this.client = undefined;
    await client.close().catch(() => undefined);
  }

  /**
   * Whether this pool has been closed, which is for ever: a closed pool opens no more sessions.
   *
   * The provider reads it to build a FRESH pool on a second `connect()`. A pool is deliberately
   * single-use - the latch is what stops a session that arrives after the close from being kept -
   * and a provider is not: `connect, disconnect, connect` on one instance used to be refused for
   * ever, with a sentence that named the one remedy it had just made impossible.
   */
  public isSpent(): boolean {
    return this.closed;
  }

  /** Whether a session is open, which `isConnected` answers from. */
  public isOpen(): boolean {
    // `replacing` is what keeps a busy connection open while its stale session is swapped: see
    // `withSession`, where the window used to make `isConnected()` answer false and cost a session.
    return this.client !== undefined || this.replacing;
  }

  /**
   * Close the session, once, and never throw.
   *
   * A close that threw would leave the caller unable to finish disconnecting, and the session would
   * then be the thing left behind. The message is kept for a caller that wants to log it, and the
   * message only: the error object carries the request that produced it.
   */
  public async close(): Promise<string | undefined> {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    // A session still opening is closed by `acquire`'s own guard above.
    if (client === undefined) return undefined;
    try {
      await client.close();
      return undefined;
    } catch (error) {
      return messageOf(error);
    }
  }
}
