/**
 * openGauss (issue #815).
 *
 * openGauss speaks the PostgreSQL wire, but authentication does not survive on
 * that alone: it sends request 10 meaning SHA256 where PostgreSQL starts SASL,
 * and request 11 meaning MD5_SHA256 where PostgreSQL continues SASL, so the
 * stock `pg` driver answers the wrong handshake - "SASL: Only mechanism(s)
 * SCRAM-SHA-256 are supported" - and the connection dies before a single query
 * is sent. That handshake is code, which is the line this product draws between
 * a wire-compatible relative - an engine an existing driver serves UNCHANGED
 * (`src/lib/db/compatibility.ts`) - and a shipped type-id with a provider, a
 * doc page and an integration test of its own. It also covers the engines
 * derived from openGauss that keep the same handshake, Huawei GaussDB and
 * Vastbase among them. One code path, both audiences.
 *
 * Everything behind the handshake is PostgreSQL's, and the issue that asked for
 * this measured it layer by layer on `opengauss/opengauss:5.0.0`: transactions,
 * rollback, parameterised queries, EXPLAIN (FORMAT JSON), foreign keys and the
 * statistics all answer; `version()` reports `9.2.4`; `regnamespace` does not
 * exist; the default schema is the user's own rather than `public`. So this
 * class extends `PostgresProvider` and overrides exactly what the handshake
 * needs, plus the gaps the PostgreSQL path measures into on this engine:
 *
 * - `buildPoolConfig` gains the socket that answers requests 10 and 11 and
 *   takes TLS negotiation with it (`opengauss-socket.ts`,
 *   `opengauss-auth.ts`),
 * - the engine's name in validation messages,
 * - `readOnlyPrivilegeSql`, because the agent read-only profile's role check is
 *   written in PostgreSQL's vocabulary, none of which this engine speaks
 *   (below), and
 * - `discardSessionState`, because the profile's post-rollback cleanup is
 *   `DISCARD ALL`, a statement this engine does not implement (below).
 *
 * `getCapabilities` and the object surface are untouched because they were not
 * measured to differ: the reads join `pg_namespace` and mark the session's
 * schema with `current_schema()`, which is the engine's own answer and is the
 * user's schema here, exactly the case that machinery exists for.
 */
import type { PoolClient, PoolConfig as PgPoolConfig } from "pg";
import { PostgresProvider } from "./postgres";
import { OpenGaussSocket, type OpenGaussTlsConfig } from "./opengauss-socket";

export class OpenGaussProvider extends PostgresProvider {
  protected override get engineLabel(): string {
    return "openGauss";
  }

  /**
   * The pool config, with the driver's TLS handling replaced by the socket's.
   *
   * `pg` is told `ssl: false` on purpose. If it were told the truth it would
   * wrap this socket in TLS during the connect, and the authentication frames
   * would live on the far side of the TLS layer where the socket's frame filter
   * stops seeing them - openGauss's requests 10 and 11 would reach `pg` again
   * and the original failure would return. The socket negotiates instead and
   * takes the TLS settings this method computes, so the connection's own ssl
   * field still means what it means for every other PostgreSQL-wire engine.
   */
  protected override buildPoolConfig(): PgPoolConfig {
    const sslConfig = this.buildSSLConfig();
    return {
      ...super.buildPoolConfig(),
      ssl: false,
      stream: () =>
        new OpenGaussSocket({
          password: this.config.password ?? "",
          tls: sslConfig && typeof sslConfig === "object" ? (sslConfig as OpenGaussTlsConfig) : undefined,
        }),
    };
  }

  /**
   * The profile's role questions, in the vocabulary this engine answers in.
   *
   * Not one of PostgreSQL's four questions is expressible here, all measured on
   * 5.0.0 against the live server: `current_setting('is_superuser')` is
   * "unrecognized configuration parameter", `to_regrole` does not exist, and
   * the three predefined roles it dereferences (`pg_read_server_files`,
   * `pg_write_server_files`, `pg_execute_server_program`) do not exist either.
   * What openGauss has instead is its own administrator flags on the role row.
   *
   * The three capability answers are the SYSTEM ADMIN flag rather than a file
   * capability, and that is deliberate. openGauss grants no server-file or
   * program capability to any role a remote session can hold: `pg_read_file()`
   * answers "must be initial account to read files" even for a SYSADMIN, the
   * initial account itself refuses remote connections ("Forbid remote
   * connection with initial user"), `COPY (…) TO PROGRAM` is not in this
   * engine's grammar at all ("syntax error at or near \"PROGRAM\""), and
   * `COPY (…) TO '<file>'` is refused outright ("COPY to or from a file is
   * prohibited for security concerns"). So the tier those capabilities sit at
   * is unreachable from here, and the tier that IS reachable above an ordinary
   * user - system admin - is refused through the capability slots the shared
   * check already fails closed on: a system administrator is not the
   * least-privilege principal this profile requires, and `true` in any of the
   * four columns is a refusal, conservatively in the safe direction.
   *
   * The row is read from `pg_roles` for `current_user`, which is the same
   * principal the connection opened as (the profile's own acquisition may have
   * substituted an agent credential, and `current_user` follows that). A row
   * the check cannot read stays unproven and is refused rather than admitted.
   */
  protected override readOnlyPrivilegeSql(): string {
    return `
        SELECT r.rolsuper         AS is_superuser,
               r.rolsystemadmin   AS reads_server_files,
               r.rolsystemadmin   AS writes_server_files,
               r.rolsystemadmin   AS executes_programs
          FROM pg_catalog.pg_roles r
         WHERE r.rolname = current_user
      `;
  }

  /**
   * The agent profile's post-rollback cleanup, in openGauss's spelling.
   *
   * `DISCARD ALL` is not implemented here ("DISCARD statement is not yet
   * supported", measured on 5.0.0 in a live session), and the state it clears
   * that a rollback does not is the session's advisory locks, which this engine
   * releases in one call. Everything else DISCARD would clear - GUCs, plans,
   * the transaction state - is transactional and died with the ROLLBACK the
   * profile already ran.
   */
  protected override async discardSessionState(client: PoolClient): Promise<void> {
    await client.query("SELECT pg_advisory_unlock_all()");
  }
}
