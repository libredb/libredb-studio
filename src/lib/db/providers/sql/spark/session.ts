/**
 * The session registry: one Spark session per request scope, a statement session for a call with no scope, and the
 * provider's metadata session, which never receives user text. No two requests run their statements on a shared
 * session: the metadata session, which the tree and panel reads share, runs no user statement, so no Studio user sees
 * another's SET, USE or temp view.
 *
 * Every new session is set up once, as a memoized promise: Config set of SPARK_SESSION_CONF (and, on the metadata
 * session, SPARK_METADATA_SESSION_CONF in the same call), SET CATALOG as a string literal, USE NAMESPACE with every part
 * quoted; both setup statements are given the moment the setup began, from which index.ts counts their deadline.
 * Every answer's server-side id is observed, so every later request of the session carries it and a restarted
 * server answers SESSION_CHANGED instead of opening a session without the setup. A release that fails changes nothing:
 * the deps log it with no server text and Spark drops the session after its idle timeout. Once close or releaseAll
 * began, the registry is closed: a session asked for later is refused with the cancelled sentence, so no session is set
 * up that no release would reach, a setup in flight sends no further step, and a metadata read sends nothing, its
 * session's setup still in flight or not. This module imports neither the channel nor execute.ts; index.ts builds its
 * deps.
 */
import { quoteLiteral } from "@/lib/sql/values";
import { SPARK_METADATA_SESSION_CONF, SPARK_SESSION_CONF } from "./constants";
import { SPARK_ERROR_SENTENCES, SparkError } from "./errors";
import { quoteSparkName } from "./namespace";
import type { SparkSessionRef } from "./requests";

export interface SparkSessionHandle extends SparkSessionRef {
  readonly kind: "request" | "statement" | "metadata";
}

/**
 * Built by index.ts over the channel. The registry holds no error context and maps no failure: a setup failure reaches
 * the statement or the read that needed the session unchanged. So `configSet` and `runSetup` reject only with a
 * SparkError, mapped by toSparkError with the phase control and the phase setup.
 */
export interface SparkSessionDeps {
  /** Config set on `session`; answers the server_side_session_id of the answer. */
  configSet(session: SparkSessionRef, pairs: readonly (readonly [string, string])[]): Promise<string>;
  /**
   * One setup statement on `session`, whose deadline counts from `setupStart`, the Date.now() at which the session's
   * setup began; answers the server_side_session_id of its answer.
   */
  runSetup(session: SparkSessionRef, sql: string, setupStart: number): Promise<string>;
  /** ReleaseSession; a failure is logged by the deps with no server text and rejected. */
  release(session: SparkSessionRef): Promise<void>;
}

/** The connection's Catalog and Namespace, which every new session is set to after its Config set. */
export interface SparkSessionPlace {
  readonly catalog?: string;
  readonly namespace?: readonly string[];
}

interface MetadataEntry {
  readonly promise: Promise<SparkSessionHandle>;
  handle?: SparkSessionHandle;
}

const closed = (error: unknown) =>
  error instanceof SparkError && (error.category === "session-closed" || error.category === "session-changed");

export class SparkSessions {
  private readonly scopes = new Map<string, Promise<SparkSessionHandle>>();
  private readonly open = new Set<SparkSessionHandle>();
  /** The setups of statement sessions, which no scope holds, while they run; releaseAll waits for them as for a scope. */
  private readonly statementSetups = new Set<Promise<SparkSessionHandle>>();
  /** Releases sent and not yet answered, a statement's own included; releaseAll answers only after them. */
  private readonly releasing = new Set<Promise<void>>();
  private metadataEntry: MetadataEntry | undefined;
  private released = false;

  constructor(
    private readonly deps: SparkSessionDeps,
    private readonly place: SparkSessionPlace,
  ) {}

  /** The scope's session, set up on its first statement and shared by the rest; no scope, a new statement session. */
  forScope(scope: string | undefined): Promise<SparkSessionHandle> {
    if (scope === undefined) {
      const created = this.create("statement");
      this.statementSetups.add(created);
      const settled = () => this.statementSetups.delete(created);
      created.then(settled, settled);
      return created;
    }
    const existing = this.scopes.get(scope);
    if (existing !== undefined) return existing;
    const created = this.create("request");
    this.scopes.set(scope, created);
    created.catch(() => {
      if (this.scopes.get(scope) === created) this.scopes.delete(scope);
    });
    return created;
  }

  metadata(): Promise<SparkSessionHandle> {
    if (this.metadataEntry === undefined) {
      const entry: MetadataEntry = { promise: this.create("metadata") };
      this.metadataEntry = entry;
      entry.promise.then(
        (handle) => {
          entry.handle = handle;
        },
        () => {
          if (this.metadataEntry === entry) this.metadataEntry = undefined;
        },
      );
    }
    return this.metadataEntry.promise;
  }

  /**
   * A provider-written read on the metadata session, repeated once on a new one when the server closed the session.
   * The repeat reads only a SparkError's category (session-closed or session-changed), so `read` maps its own failures
   * with toSparkError before they leave it: any other failure, the channel's own error for a closed session included,
   * propagates unchanged and is never repeated, and the closed session stays the current one. Once the registry closed,
   * the new session is refused with the cancelled sentence, so a read that met a released session is not repeated.
   *
   * The read waits for each session's setup, the first one and the repeat's, through `wait`, which answers the session
   * or refuses: a refusal fails the read before it is given that session, and the setup goes on for the reads after it.
   * Without `wait` the read waits as long as the setup takes. A session that comes once the registry closed belongs to
   * a connection being closed: the read is refused with the cancelled sentence and is never given it. `wait` and `read`
   * are each told whether they serve the repeat, which comes only after the server answered the first read, so a
   * refusal there can say what was sent.
   */
  async readMetadata<T>(
    read: (session: SparkSessionHandle, repeat: boolean) => Promise<T>,
    wait: (setup: Promise<SparkSessionHandle>, repeat: boolean) => Promise<SparkSessionHandle> = (setup) => setup,
  ): Promise<T> {
    const session = await wait(this.metadata(), false);
    this.assertNotReleased();
    try {
      return await read(session, false);
    } catch (error) {
      if (!closed(error)) throw error;
      if (this.metadataEntry?.handle === session) this.discardMetadata();
      const fresh = await wait(this.metadata(), true);
      this.assertNotReleased();
      try {
        return await read(fresh, true);
      } catch (again) {
        if (closed(again)) {
          throw new SparkError("session-closed", SPARK_ERROR_SENTENCES.metadataSessionLost, { cause: again });
        }
        throw again;
      }
    }
  }

  /** Releases the scope's session once its setup settled; a scope with no session, or a failed one, is nothing. */
  async endScope(scope: string): Promise<void> {
    const entry = this.scopes.get(scope);
    if (entry === undefined) return;
    this.scopes.delete(scope);
    const handle = await entry.catch(() => undefined);
    if (handle !== undefined) await this.release(handle);
  }

  endStatementSession(handle: SparkSessionHandle): Promise<void> {
    return this.release(handle);
  }

  /** Records the session's first server-side id; an empty id is nothing, and another id is a restarted server. */
  observe(handle: SparkSessionHandle, serverSideSessionId: string): void {
    if (serverSideSessionId === "") return;
    if (handle.serverSideSessionId === undefined) {
      handle.serverSideSessionId = serverSideSessionId;
      return;
    }
    if (handle.serverSideSessionId !== serverSideSessionId) {
      throw new SparkError("session-changed", SPARK_ERROR_SENTENCES.sessionChanged);
    }
  }

  /**
   * Drops the metadata session the server closed; the next metadata() sets up a new one. The caller must hold the
   * current metadata session: whatever session is current is dropped, so a caller whose session another caller already
   * replaced would drop the new one. A session still in setup was not closed by the server, so it is released once its
   * setup settles; a failed setup released its own.
   */
  discardMetadata(): void {
    const entry = this.metadataEntry;
    if (entry === undefined) return;
    this.metadataEntry = undefined;
    if (entry.handle === undefined) {
      entry.promise.then(
        (handle) => this.release(handle),
        () => undefined,
      );
    } else {
      this.open.delete(entry.handle);
    }
  }

  /**
   * Closes the registry at once and sends nothing: from here on no setup sends a further step and no metadata read is
   * given a session. The sessions stay open until releaseAll releases them.
   */
  close(): void {
    this.released = true;
  }

  /**
   * Closes the registry and releases every session, a setup still in flight included once it settles, so a release
   * never reaches the server before the session's first call. It answers once every release has answered, the ones a
   * statement or a scope's end sent before it included, so the channel closes after all of them.
   */
  async releaseAll(): Promise<void> {
    this.released = true;
    const pending = [
      ...this.scopes.values(),
      ...this.statementSetups,
      ...(this.metadataEntry === undefined ? [] : [this.metadataEntry.promise]),
    ];
    this.scopes.clear();
    this.metadataEntry = undefined;
    // Every handle a pending setup answers is still in `open`, so `open` after the wait holds them all.
    await Promise.all(pending.map((promise) => promise.catch(() => undefined)));
    await Promise.all([...this.open].map((handle) => this.release(handle)));
    await Promise.all(this.releasing);
  }

  /** Sessions created and not yet released or discarded. */
  openCount(): number {
    return this.open.size;
  }

  /**
   * Once the registry closed, whatever it is asked for belongs to a connection being disconnected: it is refused with
   * the cancelled sentence, and nothing more reaches the server for it.
   */
  private assertNotReleased(): void {
    if (this.released) throw new SparkError("cancelled", SPARK_ERROR_SENTENCES.cancelled);
  }

  /**
   * Asked for once the registry closed, nothing is sent. A setup still in flight then sends no further step: it fails
   * as cancelled before the next one, and a failed setup releases its own session.
   */
  private async create(kind: SparkSessionHandle["kind"]): Promise<SparkSessionHandle> {
    this.assertNotReleased();
    const handle: SparkSessionHandle = { sessionId: crypto.randomUUID(), kind };
    this.open.add(handle);
    // Both setup statements count their deadline from here, however long the Config set took.
    const setupStart = Date.now();
    try {
      const pairs = kind === "metadata" ? [...SPARK_SESSION_CONF, ...SPARK_METADATA_SESSION_CONF] : SPARK_SESSION_CONF;
      this.observe(handle, await this.deps.configSet(handle, pairs));
      if (this.place.catalog !== undefined) {
        this.assertNotReleased();
        this.observe(
          handle,
          await this.deps.runSetup(handle, `SET CATALOG ${quoteLiteral(this.place.catalog, "spark")}`, setupStart),
        );
      }
      if (this.place.namespace !== undefined) {
        this.assertNotReleased();
        const spelled = this.place.namespace.map(quoteSparkName).join(".");
        this.observe(handle, await this.deps.runSetup(handle, `USE NAMESPACE ${spelled}`, setupStart));
      }
      return handle;
    } catch (error) {
      await this.release(handle);
      throw error;
    }
  }

  /** Releases a handle once; a failed release changes nothing (the deps logged it). */
  private async release(handle: SparkSessionHandle): Promise<void> {
    if (!this.open.delete(handle)) return;
    const sent = (async () => {
      try {
        await this.deps.release(handle);
      } catch {
        // The statement's result is already decided, and Spark drops the session after its idle timeout.
      }
    })();
    this.releasing.add(sent);
    await sent;
    this.releasing.delete(sent);
  }
}
