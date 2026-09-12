"use client";

import { appFetch } from "@/lib/config/base-path";
import { useState, useCallback } from "react";
import {
  DatabaseConnection,
  DatabaseType,
  ConnectionEnvironment,
  ENVIRONMENT_COLORS,
  SSLMode,
  SSLConfig,
  SSHTunnelConfig,
} from "@/lib/types";
import { getDBConfig } from "@/lib/db-ui-config";
import { parseConnectionString } from "@/lib/connection-string-parser";
import { newLocalId } from "@/lib/ids";

/**
 * Whether this editor OWNS a connection field or merely carries it.
 *
 * `buildConnection` rebuilds the whole connection from form state, so every field
 * without an input here used to disappear on save — silently, because a rebuilt
 * object looks complete. Three of them had consequences nobody would connect to a
 * rename: `seedId`/`managed` are a seed copy's provenance, and losing them made the
 * connection stop matching its seed, so the next load re-created the seed copy over
 * the top and discarded the edit entirely; `agentUser`/`agentPassword` are the
 * least-privilege execution profile (#328), so losing them downgrades an agent run to
 * the connection's main credentials without saying so.
 *
 * A `Record<keyof DatabaseConnection, ...>` rather than a list of names to copy, for
 * the reason `connection-secrets.ts` gives about credentials: the failure mode of a
 * list is silence, and silence is exactly how this bug survived. A field added to
 * `DatabaseConnection`, `SSLConfig` or `SSHTunnelConfig` now fails `bun run typecheck`
 * until someone decides whether the editor owns it.
 *
 * `edited` is not "always written" — the form omits a value it has none for, which is
 * how turning TLS or the tunnel off actually clears them. It means the FORM decides.
 * `conditional` is preserved only while the related form setting remains unchanged.
 */
type FieldOwnership = "edited" | "preserved" | "conditional";

const FIELD_OWNERSHIP: Record<keyof DatabaseConnection, FieldOwnership> = {
  id: "edited",
  name: "edited",
  type: "edited",
  host: "edited",
  port: "edited",
  user: "edited",
  password: "edited",
  database: "edited",
  schema: "edited",
  queryTimeout: "edited",
  connectionString: "edited",
  createdAt: "edited",
  // Preserve a custom color while the environment is unchanged; otherwise use its palette.
  color: "conditional",
  environment: "edited",
  ssl: "edited",
  sshTunnel: "edited",
  serviceName: "edited",
  instanceName: "edited",
  localDataCenter: "edited",
  authSource: "edited",
  // The checkbox owns it, so unticking it has to CLEAR it. `preserved` would make the
  // box unticked on screen while the saved connection still skipped its scan.
  skipObjectScan: "edited",
  group: "preserved",
  managed: "preserved",
  seedId: "preserved",
  agentUser: "preserved",
  agentPassword: "preserved",
};

const SSL_OWNERSHIP: Record<keyof SSLConfig, FieldOwnership> = {
  mode: "edited",
  caCert: "edited",
  clientCert: "edited",
  clientKey: "edited",
  rejectUnauthorized: "preserved",
};

const SSH_TUNNEL_OWNERSHIP: Record<keyof SSHTunnelConfig, FieldOwnership> = {
  enabled: "edited",
  host: "edited",
  port: "edited",
  username: "edited",
  authMethod: "edited",
  password: "edited",
  privateKey: "edited",
  passphrase: "edited",
  hostKeyFingerprint: "preserved",
};

/** What survives an edit untouched. Empty for a new connection, which has no past. */
function preservedFields<T extends object>(
  source: T | null | undefined,
  ownership: Record<keyof T, FieldOwnership>,
): Partial<T> {
  if (!source) return {};
  const carried: Partial<T> = {};
  for (const key of Object.keys(ownership) as (keyof T)[]) {
    if (ownership[key] !== "preserved") continue;
    const value = source[key];
    if (value !== undefined) carried[key] = value;
  }
  return carried;
}

interface UseConnectionFormProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (conn: DatabaseConnection) => void;
  editConnection?: DatabaseConnection | null;
  /**
   * Optional API adapter: when provided, bypasses the built-in /api/db/test-connection fetch.
   *
   * `degraded` carries the same distinction the route makes: the server accepted the
   * connection and refused the health read. An adapter that does not report it keeps
   * the old two-outcome behaviour.
   */
  onTestConnection?: (
    connection: DatabaseConnection,
  ) => Promise<{ success: boolean; latency?: number; error?: string; degraded?: boolean; message?: string }>;
}

/** What the test route answered, in the shape both call sites read. */
interface TestOutcome {
  success: boolean;
  latency?: number;
  error?: string;
  degraded?: boolean;
  message?: string;
}

/**
 * What to show for a connection that exists and answers no health data.
 *
 * The server's own sentence, because it is the only thing that says which surface
 * refused - `Keyspace system_views does not exist` on ScyllaDB - and a house phrasing
 * would replace it with something less specific.
 */
function degradedSentence(result: TestOutcome): string {
  return result.message ?? result.error ?? "Connected, but this server answered no health data.";
}

/**
 * The banner's three renderings. `success` and `error` are the two outcomes the
 * banner always had; `warning` is the missing third one (#498) - a caution that is
 * neither a completed action nor a refusal, such as a degraded connect/save offer or
 * a paste that filled the form but could not apply one setting. A single field
 * instead of `success` plus a `degraded` flag, because two booleans read together is
 * exactly the shape that let a caution wear a green tick in the first place.
 */
type TestResultTone = "success" | "warning" | "error";

export function useConnectionForm({ isOpen, onConnect, editConnection, onTestConnection }: UseConnectionFormProps) {
  const [type, setType] = useState<DatabaseType>("postgres");
  const [name, setName] = useState("");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState("5432");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");
  const [schema, setSchema] = useState("");
  const [queryTimeout, setQueryTimeout] = useState("");
  const [isTesting, setIsTesting] = useState(false);
  const [connectionString, setConnectionString] = useState("");
  const [mongoConnectionMode, setMongoConnectionMode] = useState<"host" | "connectionString">("host");
  const [environment, setEnvironment] = useState<ConnectionEnvironment>("local");
  const [testResult, setTestResult] = useState<{ tone: TestResultTone; message: string; latency?: number } | null>(
    null,
  );
  const [pasteInput, setPasteInput] = useState("");
  const [showPasteInput, setShowPasteInput] = useState(false);
  /** Whether the user has been shown, and clicked past, a connection with no health surface. */
  const [degradedSaveAcknowledged, setDegradedSaveAcknowledged] = useState(false);

  // SSL/TLS
  const [showSSL, setShowSSL] = useState(false);
  const [sslMode, setSSLMode] = useState<SSLMode>("disable");
  const [caCert, setCaCert] = useState("");
  const [clientCert, setClientCert] = useState("");
  const [clientKey, setClientKey] = useState("");

  // Advanced (Oracle/MSSQL)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [serviceName, setServiceName] = useState("");
  const [instanceName, setInstanceName] = useState("");
  // Cassandra's required data centre. NOT behind the Advanced accordion that holds
  // the two above: `cassandra-driver` refuses to connect without it, so a hidden
  // field would be a connection nobody could open.
  const [localDataCenter, setLocalDataCenter] = useState("");
  // MongoDB's auth database. In the open for the same reason as the field above: it is
  // what the ordinary deployment (users in `admin`) cannot connect without.
  const [authSource, setAuthSource] = useState("");
  /**
   * Read no catalog when this connection opens (#765).
   *
   * Engine-independent, unlike the four fields above: every engine has a catalog and any
   * of them can hold an owner too big to scan on connect, so this is not gated on `type`
   * and is not behind the Advanced accordion.
   */
  const [skipObjectScan, setSkipObjectScan] = useState(false);

  // SSH Tunnel
  const [showSSH, setShowSSH] = useState(false);
  const [sshEnabled, setSSHEnabled] = useState(false);
  const [sshHost, setSSHHost] = useState("");
  const [sshPort, setSSHPort] = useState("22");
  const [sshUsername, setSSHUsername] = useState("");
  const [sshAuthMethod, setSSHAuthMethod] = useState<"password" | "privateKey">("password");
  const [sshPassword, setSSHPassword] = useState("");
  const [sshPrivateKey, setSSHPrivateKey] = useState("");
  const [sshPassphrase, setSSHPassphrase] = useState("");

  const isEditMode = !!editConnection;

  // Populate form when editing.
  //
  // Adjusted while rendering rather than in an effect, per React's "adjusting some
  // state when a prop changes": these are user-editable inputs, so they have to be
  // state, and an effect committed a frame of postgres/localhost/5432 defaults before
  // repopulating. The `{ conn }` wrapper is a sentinel, not decoration — `null` means
  // "no prop applied yet", which is what lets the FIRST render apply the target;
  // seeding the state from `editConnection` directly would skip mount, and today's
  // effect does run on mount. Comparing on `.conn` keeps exactly the identity
  // semantics of the effect's old `[editConnection]` dependency.
  const [appliedEdit, setAppliedEdit] = useState<{ conn: DatabaseConnection | null | undefined } | null>(null);
  if (!appliedEdit || appliedEdit.conn !== editConnection) {
    setAppliedEdit({ conn: editConnection });
    if (editConnection) {
      setType(editConnection.type);
      setName(editConnection.name);
      setHost(editConnection.host || "localhost");
      setPort(editConnection.port?.toString() || getDBConfig(editConnection.type).defaultPort);
      setUser(editConnection.user || "");
      setPassword(editConnection.password || "");
      setDatabase(editConnection.database || "");
      setSchema(editConnection.schema || "");
      setQueryTimeout(editConnection.queryTimeout?.toString() ?? "");
      setConnectionString(editConnection.connectionString || "");
      setEnvironment(editConnection.environment || "local");
      if (editConnection.connectionString) {
        setMongoConnectionMode("connectionString");
      }
      // Advanced fields
      if (editConnection.serviceName) {
        setServiceName(editConnection.serviceName);
        setShowAdvanced(true);
      }
      if (editConnection.instanceName) {
        setInstanceName(editConnection.instanceName);
        setShowAdvanced(true);
      }
      // Overwritten, not conditionally set like the two Advanced fields above: a
      // connection that carries no data centre must show an empty field, or the
      // previously edited ring's name gets saved onto this one.
      setLocalDataCenter(editConnection.localDataCenter || "");
      // Overwritten for the same reason: a connection that names no auth database must
      // show an empty field, not the last one edited.
      setAuthSource(editConnection.authSource || "");
      // Overwritten, not set only when true: a connection that reads its catalog has to
      // show an unticked box, or the previously edited connection's choice is saved onto
      // it and the catalog silently stops being read.
      setSkipObjectScan(editConnection.skipObjectScan === true);
      // SSL
      if (editConnection.ssl) {
        setSSLMode(editConnection.ssl.mode);
        setCaCert(editConnection.ssl.caCert || "");
        setClientCert(editConnection.ssl.clientCert || "");
        setClientKey(editConnection.ssl.clientKey || "");
        if (editConnection.ssl.mode !== "disable") setShowSSL(true);
      }
      // SSH
      if (editConnection.sshTunnel?.enabled) {
        setSSHEnabled(true);
        setShowSSH(true);
        setSSHHost(editConnection.sshTunnel.host);
        setSSHPort(editConnection.sshTunnel.port.toString());
        setSSHUsername(editConnection.sshTunnel.username);
        setSSHAuthMethod(editConnection.sshTunnel.authMethod);
        setSSHPassword(editConnection.sshTunnel.password || "");
        setSSHPrivateKey(editConnection.sshTunnel.privateKey || "");
        setSSHPassphrase(editConnection.sshTunnel.passphrase || "");
      }
    }
  }

  // Reset the form when the dialog closes, AND when the edit target goes away while it
  // is already closed — adjusted while rendering for the same reason as the block
  // above, and placed here so the two still run in the order the two effects did.
  //
  // The second trigger is what keeps the previous connection's credentials out of the
  // next dialog. Editing X and then clearing the target while closed leaves X's name,
  // user, password and database in this state, and the Add-Connection dialog opens with
  // them. The shell happens to clear `editConnection` and `isOpen` in the same handler,
  // so `isOpen` co-changes today — but that is the caller's business, and a credential
  // leak may not rest on it, so the guard covers the transition on its own terms.
  //
  // Presence, not identity: X -> Y is a new edit target, which the block above
  // repopulates in full, and re-running the reset for it would only rewrite the same
  // constants. The sentinel IS seeded from the props, unlike `appliedEdit` above,
  // because there is nothing for a mount pass to do: in edit mode the body skips the
  // field block entirely, and the four transient values it clears already start out
  // null/false/"".
  const [lastReset, setLastReset] = useState({ isOpen, isEditMode });
  if (isOpen !== lastReset.isOpen || isEditMode !== lastReset.isEditMode) {
    setLastReset({ isOpen, isEditMode });
    if (!isOpen) {
      setTestResult(null);
      setShowPasteInput(false);
      setPasteInput("");
      // The next connection typed into this dialog has not been warned about anything.
      setDegradedSaveAcknowledged(false);
      if (!editConnection) {
        setName("");
        setUser("");
        setPassword("");
        setDatabase("");
        setSchema("");
        setQueryTimeout("");
        setConnectionString("");
        setMongoConnectionMode("host");
        setType("postgres");
        setHost("localhost");
        setPort("5432");
        // Cassandra topology, so a leftover is not cosmetic: the next new connection
        // would dial its host with the previous ring's data centre, which the driver
        // either refuses or - when the name exists on both rings - accepts as a
        // silently wrong topology.
        setLocalDataCenter("");
        // A leftover auth database sends the next connection's credentials to a
        // database that may not hold them, which reads as a wrong password.
        setAuthSource("");
        // A leftover choice would open the next connection with no object list and no
        // explanation, which reads as an engine that answered nothing.
        setSkipObjectScan(false);
      }
    }
  }

  const buildConnection = useCallback((): DatabaseConnection => {
    const sslConfig: SSLConfig | undefined =
      sslMode !== "disable"
        ? {
            mode: sslMode,
            ...(caCert ? { caCert } : {}),
            ...(clientCert ? { clientCert } : {}),
            ...(clientKey ? { clientKey } : {}),
            ...(editConnection?.ssl?.mode === sslMode ? preservedFields(editConnection.ssl, SSL_OWNERSHIP) : {}),
          }
        : undefined;

    const sshConfig: SSHTunnelConfig | undefined = sshEnabled
      ? {
          enabled: true,
          host: sshHost,
          port: parseInt(sshPort) || 22,
          username: sshUsername,
          authMethod: sshAuthMethod,
          ...(sshAuthMethod === "password" ? { password: sshPassword } : {}),
          ...(sshAuthMethod === "privateKey" ? { privateKey: sshPrivateKey } : {}),
          ...(sshPassphrase ? { passphrase: sshPassphrase } : {}),
          // A pinned host key belongs to this SSH endpoint, not to a replacement bastion.
          ...(editConnection?.sshTunnel?.host === sshHost && editConnection.sshTunnel.port === (parseInt(sshPort) || 22)
            ? preservedFields(editConnection.sshTunnel, SSH_TUNNEL_OWNERSHIP)
            : {}),
        }
      : undefined;

    /*
      Write only the addressing fields this engine actually takes — the same list the
      modal renders inputs from, which is now true: `ConnectionModal` gates its Username
      and Database inputs on `takesConnectionField`, so a box exists exactly where a value
      is written. It did not hold when this comment was first written, and the gap was
      silent in both directions — libSQL and the search engines drew boxes nothing carried,
      while Redis had its ACL user discarded by a list that omitted the field its own
      provider authenticates with. A file-addressed engine (SQLite, LibreDB) takes a
      path and nothing else, yet this used to write `host: "localhost"`, an empty user
      and password, and a port parsed out of an empty string. That looks harmless and
      is not: a seed descriptor carries none of them, so a copy the editor had touched
      stopped matching its seed, which discarded the user's edit on the next load and
      made the agent rail refuse a connection it had just accepted.
    */
    const addressedFields = new Set<string>(getDBConfig(type).connectionFields);

    return {
      // First, so a form-owned field always wins.
      ...preservedFields(editConnection, FIELD_OWNERSHIP),
      id: editConnection?.id || newLocalId(),
      name: name || `${type}-connection`,
      type,
      ...(addressedFields.has("host") ? { host } : {}),
      ...(addressedFields.has("port") ? { port: parseInt(port) } : {}),
      ...(addressedFields.has("user") ? { user } : {}),
      ...(addressedFields.has("password") ? { password } : {}),
      ...(addressedFields.has("database") ? { database } : {}),
      ...(addressedFields.has("schema") && schema ? { schema } : {}),
      ...(queryTimeout.trim() ? { queryTimeout: Number(queryTimeout) } : {}),
      createdAt: editConnection?.createdAt || new Date(),
      environment,
      color:
        editConnection?.color && (editConnection.environment ?? "local") === environment
          ? editConnection.color
          : ENVIRONMENT_COLORS[environment],
      ...(sslConfig ? { ssl: sslConfig } : {}),
      ...(sshConfig ? { sshTunnel: sshConfig } : {}),
      ...(getDBConfig(type).showConnectionStringToggle && mongoConnectionMode === "connectionString"
        ? {
            connectionString,
            host: undefined,
            port: undefined,
            user: undefined,
            password: undefined,
          }
        : {}),
      ...(type === "oracle" && serviceName ? { serviceName } : {}),
      ...(type === "mssql" && instanceName ? { instanceName } : {}),
      ...(type === "cassandra" && localDataCenter ? { localDataCenter } : {}),
      ...(type === "mongodb" && authSource ? { authSource } : {}),
      // Written only when it says something, like every other optional field here: a
      // stored `false` is noise on every connection ever saved.
      ...(skipObjectScan ? { skipObjectScan } : {}),
    };
  }, [
    sslMode,
    caCert,
    clientCert,
    clientKey,
    sshEnabled,
    sshHost,
    sshPort,
    sshUsername,
    sshAuthMethod,
    sshPassword,
    sshPrivateKey,
    sshPassphrase,
    editConnection,
    name,
    type,
    host,
    port,
    user,
    password,
    database,
    schema,
    queryTimeout,
    environment,
    mongoConnectionMode,
    connectionString,
    serviceName,
    instanceName,
    localDataCenter,
    authSource,
    skipObjectScan,
  ]);

  /**
   * The one place the connection is probed, for both buttons.
   *
   * The two call sites had a copy each of the adapter/fetch branch, and the copies
   * had already diverged: the save path read only `success` and threw the rest of the
   * answer away, which is how a degraded outcome became indistinguishable from a
   * refusal.
   */
  const probeConnection = useCallback(
    async (conn: DatabaseConnection): Promise<TestOutcome> => {
      // Platform adapter: use callback instead of fetch
      if (onTestConnection) return await onTestConnection(conn);

      const response = await appFetch("/api/db/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(conn),
      });

      return await response.json();
    },
    [onTestConnection],
  );

  const validateQueryTimeout = useCallback(() => {
    const value = Number(queryTimeout);
    if (queryTimeout.trim() && (!Number.isInteger(value) || value < 1 || value > 2147483647)) {
      setTestResult({
        tone: "error",
        message: "Query timeout must be a whole number between 1 and 2147483647 milliseconds.",
      });
      return false;
    }
    return true;
  }, [queryTimeout]);

  const handleTestConnection = useCallback(async () => {
    if (!validateQueryTimeout()) return;
    setIsTesting(true);
    setTestResult(null);

    try {
      const result = await probeConnection(buildConnection());

      setTestResult({
        // A degraded connection IS connected, so it is not an error - but saying
        // "Connected successfully" and nothing else is what hid the missing
        // monitoring surface until the dashboard showed an error page. It is not a
        // plain success either: it is the same caution `handleConnect` offers below,
        // so it gets the same warning tone rather than the green tick.
        tone: !result.success ? "error" : result.degraded ? "warning" : "success",
        message: result.success
          ? result.degraded
            ? degradedSentence(result)
            : `Connected successfully${result.latency ? ` (${result.latency}ms)` : ""}`
          : result.error || "Connection failed",
        latency: result.latency,
      });
    } catch {
      setTestResult({ tone: "error", message: "Network error - could not reach server" });
    } finally {
      setIsTesting(false);
    }
  }, [buildConnection, probeConnection, validateQueryTimeout]);

  const handleConnect = useCallback(async () => {
    if (!validateQueryTimeout()) return;
    setIsTesting(true);
    setTestResult(null);

    try {
      const conn = buildConnection();
      const result = await probeConnection(conn);

      if (!result.success) {
        setTestResult({ tone: "error", message: result.error || "Connection failed" });
        return;
      }

      /*
        A server that connects and runs statements is usable, so the save no longer
        depends on its health surface answering. Three published engines
        were unsaveable on that gate alone - ScyllaDB, whose health read asks for a
        `system_views` keyspace the build does not have, plus StarRocks and SingleStore
        (whose health reads died on the prepared-statement protocol until 2026-08-24) -
        while the editor and the object browser worked in full.

        What the save may NOT become is silent. The first click reports what the server
        refused, in its own words, and saves nothing; only a second one saves. The
        acknowledgement is withdrawn when the dialog closes, so the next connection
        typed here gets told too.
      */
      if (result.degraded === true && !degradedSaveAcknowledged) {
        setDegradedSaveAcknowledged(true);
        setTestResult({
          // The save is being OFFERED, not refused, and not yet completed either - a
          // sentence that asks the user to click again does not belong under a
          // "success" tick (#498). This is the same class as the degraded
          // `handleTestConnection` message above: connected, but the server answered
          // no health data.
          tone: "warning",
          // The button's own label, because the dialog renders two of them: "Save
          // Changes" when editing and "Establish Connection" when creating, and naming
          // a button that is not on screen is worse than naming none.
          message: `${degradedSentence(result)} Click ${
            isEditMode ? "Save Changes" : "Establish Connection"
          } again to save it anyway.`,
        });
        return;
      }

      onConnect(conn);
      setQueryTimeout("");
      // Reset form
      setName("");
      setUser("");
      setPassword("");
      setDatabase("");
      setConnectionString("");
      setMongoConnectionMode("host");
      setTestResult(null);
    } catch {
      setTestResult({ tone: "error", message: "Network error - could not reach server" });
    } finally {
      setIsTesting(false);
    }
  }, [buildConnection, degradedSaveAcknowledged, isEditMode, onConnect, probeConnection, validateQueryTimeout]);

  const handlePasteConnectionString = useCallback(() => {
    const trimmed = pasteInput.trim();
    if (!trimmed) return;

    const parsed = parseConnectionString(trimmed);
    if (!parsed) {
      setTestResult({
        tone: "error",
        // One scheme per branch in connection-string-parser.ts, and nothing else.
        // Elasticsearch, OpenSearch and Trino are absent on purpose: all three are
        // addressed by host and port like Druid, and `http(s)://` already resolves to
        // ClickHouse there, so listing them would promise a paste this form cannot
        // honour. Trino's own `jdbc:trino://…` is a JDBC URL the parser does not read.
        // DuckDB, SQLite and the embedded store are absent for a different reason:
        // they are FILE-based, `showConnectionStringToggle` is false for all three, so
        // this control is never rendered for them and no scheme is being withheld.
        message:
          "Could not parse connection string. Supported formats: postgres://, mysql://, mongodb://, couchbase://, clickhouse://, libsql://, http(s)://, redis://, oracle://, mssql://",
      });
      return;
    }

    // Auto-switch DB type
    setType(parsed.type);
    if (parsed.host) setHost(parsed.host);
    if (parsed.port) setPort(parsed.port);
    if (parsed.user) setUser(parsed.user);
    if (parsed.password) setPassword(parsed.password);
    if (parsed.database) setDatabase(parsed.database);
    // A scheme that IS the transport (https:// for ClickHouse) carries TLS that no
    // field can express. Without this the form keeps its "disable" default and the
    // connection goes out as plaintext HTTP to a TLS port.
    if (parsed.sslMode) setSSLMode(parsed.sslMode);

    // A provider whose form offers the URI mode (MongoDB, Couchbase) switches to it,
    // so the pasted string is what gets connected with rather than a lossy re-assembly
    // of the fields parsed out of it.
    if (getDBConfig(parsed.type).showConnectionStringToggle && parsed.connectionString) {
      setConnectionString(parsed.connectionString);
      setMongoConnectionMode("connectionString");
    }

    // Auto-fill name if empty
    if (!name) {
      const dbName = parsed.database || parsed.host || parsed.type;
      setName(`${dbName}`);
    }

    setShowPasteInput(false);
    setPasteInput("");
    // A TLS parameter the parser refused to map is the one thing a green "parsed
    // successfully" must not swallow: the user asked for encryption and the form is still
    // showing whatever mode it held. Postgres's `prefer`/`allow` and MySQL's `PREFERRED`
    // mean "encrypt if the server offers it", which SSL Mode cannot express, and guessing
    // either end is measurably wrong in both directions (see connection-string-parser.ts).
    // So name the parameter, name the mode that is actually in force, and say where to fix it.
    //
    // The paste itself worked - every other field is filled in - so this is not a
    // failure, but a green tick over "your TLS setting was dropped" would be exactly
    // the defect #449 names (an affordance that contradicts its own sentence), just
    // in its most dangerous direction. Originally emitted as `success: false` for want
    // of a third rendering (#U19 found the same missing state one branch below, in
    // `handleConnect`'s degraded save); now that the warning tone exists for that
    // caller too, this is the same caution and gets the same tone. The sentence still
    // leads with what was NOT applied and says outright that the other fields were.
    if (parsed.unmappedTLSParam) {
      setTestResult({
        tone: "warning",
        message: `TLS setting not applied: "${parsed.unmappedTLSParam}" has no equivalent among disable, require, verify-system, verify-ca and verify-full. The other fields were filled in, but SSL Mode stays "${sslMode}" - open SSL / TLS and choose one before connecting.`,
      });
      return;
    }
    setTestResult({
      tone: "success",
      message: "Connection string parsed successfully. Review the fields and connect.",
    });
  }, [pasteInput, name, sslMode]);

  // Ordered for display (the modal renders these as a 2-column grid), and covering the whole
  // DatabaseType union — the same form edits existing connections, so an omitted type leaves the
  // picker with nothing selected. tests/hooks/use-connection-form.test.ts enforces the coverage.
  const selectableTypes: DatabaseType[] = [
    "postgres",
    "mysql",
    "sqlite",
    "oracle",
    "mssql",
    "mongodb",
    "couchbase",
    "redis",
    "libredb",
    "clickhouse",
    "druid",
    "elasticsearch",
    "opensearch",
    "trino",
    "cassandra",
    "libsql",
    "duckdb",
  ];
  const dbTypes = selectableTypes.map((t) => {
    const cfg = getDBConfig(t);
    return { value: t, label: cfg.label, icon: cfg.icon, color: cfg.color };
  });

  return {
    // Connection fields
    type,
    setType,
    name,
    setName,
    host,
    setHost,
    port,
    setPort,
    user,
    setUser,
    password,
    setPassword,
    database,
    schema,
    setDatabase,
    setSchema,
    queryTimeout,
    setQueryTimeout,
    connectionString,
    setConnectionString,
    mongoConnectionMode,
    setMongoConnectionMode,
    environment,
    setEnvironment,

    // UI state
    isTesting,
    testResult,
    setTestResult,
    pasteInput,
    setPasteInput,
    showPasteInput,
    setShowPasteInput,
    isEditMode,

    // SSL/TLS
    showSSL,
    setShowSSL,
    sslMode,
    setSSLMode,
    caCert,
    setCaCert,
    clientCert,
    setClientCert,
    clientKey,
    setClientKey,

    // Advanced (Oracle/MSSQL)
    showAdvanced,
    setShowAdvanced,
    serviceName,
    setServiceName,
    instanceName,
    setInstanceName,
    localDataCenter,
    setLocalDataCenter,
    authSource,
    setAuthSource,
    skipObjectScan,
    setSkipObjectScan,

    // SSH Tunnel
    showSSH,
    setShowSSH,
    sshEnabled,
    setSSHEnabled,
    sshHost,
    setSSHHost,
    sshPort,
    setSSHPort,
    sshUsername,
    setSSHUsername,
    sshAuthMethod,
    setSSHAuthMethod,
    sshPassword,
    setSSHPassword,
    sshPrivateKey,
    setSSHPrivateKey,
    sshPassphrase,
    setSSHPassphrase,

    // Handlers
    handleTestConnection,
    handleConnect,
    handlePasteConnectionString,

    // Derived data
    dbTypes,
  };
}
