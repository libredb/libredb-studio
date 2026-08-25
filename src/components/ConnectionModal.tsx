"use client";

import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DatabaseConnection,
  ConnectionEnvironment,
  ENVIRONMENT_COLORS,
  ENVIRONMENT_LABELS,
  SSLMode,
} from "@/lib/types";
import {
  Database,
  ShieldCheck,
  Zap,
  Globe,
  Key,
  Link,
  CircleCheck,
  CircleX,
  TriangleAlert,
  ClipboardPaste,
  Lock,
  ChevronDown,
  Terminal,
  Settings2,
  Server,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getDBConfig, isFileBased } from "@/lib/db-ui-config";
import { motion, AnimatePresence } from "framer-motion";
import { useConnectionForm } from "@/hooks/use-connection-form";
import { useIsMobile } from "@/hooks/use-mobile";
import { WireCompatibilityHint } from "@/components/WireCompatibilityHint";

/**
 * What each SSL mode actually does, in the panel where it is chosen.
 *
 * `verify-system` is the one that needs the sentence most (D26): without it a reader cannot
 * tell it from `verify-ca` and goes looking for a CA file that mode does not want. The
 * SSLMode union is published (src/lib/types.ts), so this Record is exhaustive by type - a
 * mode added there without copy here fails typecheck rather than rendering an empty hint.
 */
const SSL_MODE_HINTS: Record<SSLMode, string> = {
  disable: "Plaintext. Nothing is encrypted.",
  require: "Encrypts but verifies nothing - any certificate is accepted, including a forged one.",
  "verify-system":
    "Encrypts and verifies the certificate chain and host name against the system trust store - no certificate to paste. Use this for a managed endpoint (Neon, Supabase, Atlas, RDS, Capella).",
  "verify-ca": "Encrypts and verifies the chain against the CA certificate below. Paste one for a private CA.",
  "verify-full":
    "Encrypts and verifies the chain against the CA certificate below, and that it names the host you typed.",
};

interface ConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (conn: DatabaseConnection) => void;
  editConnection?: DatabaseConnection | null;
  /** Optional API adapter: when provided, bypasses the built-in /api/db/test-connection fetch. */
  onTestConnection?: (
    connection: DatabaseConnection,
  ) => Promise<{ success: boolean; latency?: number; error?: string }>;
}

export function ConnectionModal({
  isOpen,
  onClose,
  onConnect,
  editConnection,
  onTestConnection,
}: ConnectionModalProps) {
  const isMobile = useIsMobile();
  const {
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
    setDatabase,
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
  } = useConnectionForm({ isOpen, onClose, onConnect, editConnection, onTestConnection });

  // Couchbase pins one bucket per connection (issue #262, decision 4), so the shared
  // `database` field holds a bucket name and the form must say so.
  const isCouchbase = type === "couchbase";
  // Trino pins one CATALOG the same way (issue #424 Phase 2). "Database" would be the
  // wrong word twice over: a Trino catalog is a whole external system (`hive`,
  // `iceberg`, `tpch`), and the field is the one thing a user cannot guess - a
  // coordinator with no catalog selected resolves no table at all.
  const isTrino = type === "trino";
  // Cassandra pins one KEYSPACE the same way (issue #424 Phase 4). "Database" is the
  // wrong word here too: a keyspace carries the replication settings, not just a
  // namespace, and without one pinned an unqualified table name resolves to nothing
  // at all - measured on 5.0.9, "No keyspace has been specified. USE a keyspace, or
  // explicitly specify keyspace.tablename".
  const isCassandra = type === "cassandra";
  // MongoDB keeps its users in a database of their own, and the driver checks the
  // credentials against whichever database the URI names when nothing says otherwise.
  // So the ordinary deployment - users in `admin`, data elsewhere - had no way through
  // the discrete fields at all, and failed as a credentials error.
  const isMongoDB = type === "mongodb";
  const databaseFieldLabel = isCouchbase ? "Bucket" : isTrino ? "Catalog" : isCassandra ? "Keyspace" : "Database";
  const databaseFieldPlaceholder = isTrino ? "tpch" : isCassandra ? "probe" : "db";
  const connectionUriPlaceholder = isCouchbase
    ? "couchbase://localhost:8091/travel-sample  or  couchbases://cb.<id>.cloud.couchbase.com/..."
    : "mongodb://localhost:27017/mydb  or  mongodb+srv://...";

  const formContent = (
    <>
      {/* Progress bar — fixed top */}
      <div className="shrink-0 h-2 w-full bg-blue-600/20">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: "100%" }}
          className="h-full bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.5)]"
        />
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="mb-4 md:mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-xl bg-blue-500/10 border border-blue-500/20">
              <Zap strokeWidth={1.5} className="w-5 h-5 text-blue-400" />
            </div>
            <h2 className="text-xs md:text-[0.8125rem] font-medium">
              {isEditMode ? "Edit Connection" : "New Connection"}
            </h2>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-fg-muted">
              {isEditMode
                ? "Update your database connection parameters."
                : "Configure your database connection parameters securely."}
            </p>
            {!isEditMode && (
              <button
                onClick={() => setShowPasteInput(!showPasteInput)}
                className="flex items-center gap-1.5 text-xs font-mediumr text-blue-400 hover:text-blue-300 transition-colors px-2 py-1 rounded-md hover:bg-blue-500/10"
              >
                <ClipboardPaste strokeWidth={1.5} className="w-3 h-3" />
                Paste URL
              </button>
            )}
          </div>
        </div>

        {/* Paste Connection String Input */}
        <AnimatePresence>
          {showPasteInput && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="mb-6 overflow-hidden"
            >
              <div className="p-3 rounded-lg border border-blue-500/20 bg-blue-500/5 space-y-2">
                <Label className="text-xs font-mediumr text-blue-400">Paste Connection URL</Label>
                <div className="flex gap-2">
                  <Input
                    value={pasteInput}
                    onChange={(e) => setPasteInput(e.target.value)}
                    placeholder="postgres://user:pass@host:5432/db  or  mongodb://..."
                    className="h-9 bg-panel border-hairline focus:border-blue-500/50 text-xs font-mono flex-1"
                    onKeyDown={(e) => e.key === "Enter" && handlePasteConnectionString()}
                  />
                  <Button
                    size="sm"
                    onClick={handlePasteConnectionString}
                    className="bg-blue-600 hover:bg-blue-500 text-white h-9 px-4 text-xs font-medium"
                  >
                    Parse
                  </Button>
                </div>
                <p className="text-xs text-fg-muted">
                  Supports: postgres://, mysql://, mongodb://, redis://, oracle://, mssql://
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="space-y-4 md:space-y-6">
          {/* Connection Name - always visible */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 mb-1">
              <Database strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
              <Label htmlFor="name" className="text-xs font-mediumr text-fg-muted">
                Connection Name
              </Label>
            </div>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Database"
              className="h-10 bg-panel border-hairline focus:border-blue-500/50 transition-all text-xs"
            />
          </div>

          {/* Environment Selector */}
          <div className="space-y-2">
            <Label className="text-xs font-mediumr text-fg-muted">Environment</Label>
            <div className="flex flex-wrap items-center gap-2">
              {(Object.keys(ENVIRONMENT_COLORS) as ConnectionEnvironment[]).map((env) => (
                <button
                  key={env}
                  onClick={() => setEnvironment(env)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mediumr transition-all border",
                    environment === env
                      ? "border-edge bg-fill text-fg"
                      : "border-transparent text-fg-muted hover:text-fg-secondary hover:bg-fill",
                  )}
                >
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: ENVIRONMENT_COLORS[env] }} />
                  {env === "other" ? "Other" : ENVIRONMENT_LABELS[env]}
                </button>
              ))}
            </div>
          </div>

          {/* DB Type Selector */}
          <div className="grid grid-cols-2 gap-3">
            {dbTypes.map((db) => (
              <button
                key={db.value}
                onClick={() => {
                  setType(db.value);
                  const cfg = getDBConfig(db.value);
                  if (cfg.defaultPort) setPort(cfg.defaultPort);
                  setTestResult(null);
                }}
                disabled={isEditMode}
                className={cn(
                  "flex flex-col items-center justify-center p-3 md:p-4 rounded-xl border transition-all duration-200 gap-2 group",
                  type === db.value
                    ? "bg-blue-600/10 border-blue-500/50 shadow-[0_0_20px_rgba(59,130,246,0.1)]"
                    : "bg-panel border-hairline hover:border-hairline-strong hover:bg-raised",
                  isEditMode && type !== db.value && "opacity-30 cursor-not-allowed",
                )}
              >
                <db.icon
                  className={cn(
                    "w-6 h-6 mb-1 transition-transform group-hover:scale-110",
                    type === db.value ? db.color : "text-fg-subtle",
                  )}
                />
                <span className={cn("text-xs font-medium", type === db.value ? "text-fg" : "text-fg-muted")}>
                  {db.label}
                </span>
              </button>
            ))}
          </div>

          {/* Wire-compatible engines served by the selected driver (#424) */}
          <WireCompatibilityHint type={type} />

          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <>
              {/* Connection string mode toggle */}
              {getDBConfig(type).showConnectionStringToggle && (
                <div className="flex items-center gap-2 p-1 rounded-lg bg-panel border border-hairline">
                  <button
                    onClick={() => setMongoConnectionMode("host")}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-medium transition-all",
                      mongoConnectionMode === "host"
                        ? "bg-blue-600/20 text-blue-400 border border-blue-500/30"
                        : "text-fg-muted hover:text-fg-secondary",
                    )}
                  >
                    <Globe strokeWidth={1.5} className="w-3 h-3" />
                    Host / Port
                  </button>
                  <button
                    onClick={() => setMongoConnectionMode("connectionString")}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-medium transition-all",
                      mongoConnectionMode === "connectionString"
                        ? "bg-blue-600/20 text-blue-400 border border-blue-500/30"
                        : "text-fg-muted hover:text-fg-secondary",
                    )}
                  >
                    <Link strokeWidth={1.5} className="w-3 h-3" />
                    Connection String
                  </button>
                </div>
              )}

              {getDBConfig(type).showConnectionStringToggle && mongoConnectionMode === "connectionString" ? (
                <>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 mb-1">
                      <Link strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                      <Label htmlFor="connectionString" className="text-xs font-mediumr text-fg-muted">
                        Connection URI
                      </Label>
                    </div>
                    <Input
                      id="connectionString"
                      value={connectionString}
                      onChange={(e) => setConnectionString(e.target.value)}
                      placeholder={connectionUriPlaceholder}
                      className="h-10 bg-panel border-hairline focus:border-blue-500/50 transition-all text-xs font-mono"
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 mb-1">
                      <Database strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                      <Label htmlFor="database" className="text-xs font-mediumr text-fg-muted">
                        {databaseFieldLabel} Name (optional override)
                      </Label>
                    </div>
                    <Input
                      id="database"
                      value={database}
                      onChange={(e) => setDatabase(e.target.value)}
                      placeholder="Extracted from URI if not provided"
                      className="h-10 bg-panel border-hairline focus:border-blue-500/50 transition-all text-xs font-mono"
                    />
                  </div>
                </>
              ) : isFileBased(type) ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 mb-1">
                    <Database strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                    <Label htmlFor="database" className="text-xs font-medium text-fg-muted">
                      Database File Path
                    </Label>
                  </div>
                  <Input
                    id="database"
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    placeholder="/path/to/database file"
                    className="h-10 bg-panel border-hairline focus:border-blue-500/50 transition-all text-xs font-mono"
                  />
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 mb-1">
                      <Globe strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                      <Label htmlFor="host" className="text-xs font-mediumr text-fg-muted">
                        Host & Instance
                      </Label>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                      <Input
                        id="host"
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                        placeholder="localhost"
                        autoComplete="off"
                        className="md:col-span-3 h-10 bg-panel border-hairline focus:border-blue-500/50 transition-all text-xs"
                      />
                      <Input
                        id="port"
                        value={port}
                        onChange={(e) => setPort(e.target.value)}
                        autoComplete="off"
                        className="h-10 bg-panel border-hairline focus:border-blue-500/50 transition-all text-xs font-mono"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 mb-1">
                        <Key strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                        <Label htmlFor="user" className="text-xs font-mediumr text-fg-muted">
                          Username
                        </Label>
                      </div>
                      <Input
                        id="user"
                        value={user}
                        onChange={(e) => setUser(e.target.value)}
                        placeholder="user"
                        autoComplete="off"
                        className="h-10 bg-panel border-hairline focus:border-blue-500/50 transition-all text-xs"
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 mb-1">
                        <ShieldCheck strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                        <Label htmlFor="password" className="text-xs font-mediumr text-fg-muted">
                          Password
                        </Label>
                      </div>
                      <Input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="***"
                        // Server credential, not the user's own login: "new-password" is the only
                        // value Chrome honours to keep saved site passwords out of the field.
                        autoComplete="new-password"
                        className="h-10 bg-panel border-hairline focus:border-blue-500/50 transition-all text-xs"
                      />
                      {/*
                        Measured on Trino 476 with authentication DISABLED: a request
                        carrying `Authorization: Basic` over plain HTTP is answered 401,
                        "Password not allowed for insecure authentication". So a
                        password is a TLS-only credential here, and typing one into an
                        http:// connection BREAKS a connection that would otherwise
                        work. The provider refuses the combination outright; this says
                        so before the user reaches that error.
                      */}
                      {isTrino && (
                        <p className="text-xs text-fg-muted">
                          Trino refuses a password over plain HTTP. Enable TLS below, or leave this empty to connect as
                          an unauthenticated user.
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-2 mb-1">
                      <Database strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                      <Label htmlFor="database" className="text-xs font-mediumr text-fg-muted">
                        {databaseFieldLabel} Name
                      </Label>
                    </div>
                    <Input
                      id="database"
                      value={database}
                      onChange={(e) => setDatabase(e.target.value)}
                      placeholder={databaseFieldPlaceholder}
                      className="h-10 bg-panel border-hairline focus:border-blue-500/50 transition-all text-xs font-mono"
                    />
                    {isTrino && (
                      <p className="text-xs text-fg-muted">
                        The Trino catalog to open, such as tpch or hive. Its schemas are the level below.
                      </p>
                    )}
                    {isCassandra && (
                      <p className="text-xs text-fg-muted">
                        The keyspace to open. Tables inside it are the level below; statements can still name any
                        keyspace in full.
                      </p>
                    )}
                  </div>

                  {/*
                    In the open rather than behind the Advanced accordion for the
                    reason Cassandra's field below is: the deployment that needs it is
                    the ordinary one, and the failure without it is a credentials error
                    that names nothing. The connection-string mode has no such field -
                    a pasted URI carries `?authSource=` itself.
                  */}
                  {isMongoDB && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 mb-1">
                        <Key strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                        <Label htmlFor="authSource" className="text-xs font-medium text-fg-muted">
                          Authentication Database
                        </Label>
                      </div>
                      <Input
                        id="authSource"
                        value={authSource}
                        onChange={(e) => setAuthSource(e.target.value)}
                        placeholder="admin"
                        className="h-10 bg-panel border-hairline focus:border-blue-500/50 transition-all text-xs font-mono"
                      />
                      <p className="text-xs text-fg-muted">
                        The database the user was created in, usually admin. Leave empty when the credentials live in
                        the database above.
                      </p>
                    </div>
                  )}

                  {/*
                    Rendered in the open, not behind the Advanced accordion that holds
                    Oracle's service name and SQL Server's instance name. Those two are
                    refinements; this one is mandatory - `cassandra-driver` refuses to
                    build a load-balancing policy without it, so a connection with this
                    empty cannot open at all.
                  */}
                  {isCassandra && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 mb-1">
                        <Server strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                        <Label htmlFor="localDataCenter" className="text-xs font-medium text-fg-muted">
                          Local Data Center
                        </Label>
                      </div>
                      <Input
                        id="localDataCenter"
                        value={localDataCenter}
                        onChange={(e) => setLocalDataCenter(e.target.value)}
                        placeholder="datacenter1"
                        className="h-10 bg-panel border-hairline focus:border-blue-500/50 transition-all text-xs font-mono"
                      />
                      <p className="text-xs text-fg-muted">
                        Required: the Cassandra driver refuses to connect without it. A stock single-node install
                        reports datacenter1; the server lists the ones it has if this is wrong.
                      </p>
                    </div>
                  )}
                </>
              )}
            </>
          </div>

          {/* Advanced Settings (Oracle/MSSQL) */}
          {(type === "oracle" || type === "mssql") && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-hairline hover:border-hairline-strong bg-panel text-xs font-medium text-fg-tertiary hover:text-fg transition-all"
              >
                <Settings2 strokeWidth={1.5} className="w-3.5 h-3.5 text-orange-500" />
                <span>Advanced</span>
                {(serviceName || instanceName) && (
                  <span className="ml-1 px-1.5 py-0.5 rounded text-[0.625rem] bg-orange-500/10 text-orange-400 border border-orange-500/20">
                    SET
                  </span>
                )}
                <ChevronDown className={cn("w-3 h-3 ml-auto transition-transform", showAdvanced && "rotate-180")} />
              </button>
              <AnimatePresence>
                {showAdvanced && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="p-3 rounded-lg border border-orange-500/10 bg-orange-500/5 space-y-3">
                      {type === "oracle" && (
                        <div className="space-y-1.5">
                          <Label className="text-xs font-mediumr text-fg-muted">Service Name</Label>
                          <Input
                            value={serviceName}
                            onChange={(e) => setServiceName(e.target.value)}
                            placeholder="ORCL or XEPDB1"
                            className="h-9 bg-panel border-hairline focus:border-orange-500/50 text-xs"
                          />
                          <p className="text-xs text-fg-muted">
                            If empty, the Database Name field is used as the service name.
                          </p>
                        </div>
                      )}
                      {type === "mssql" && (
                        <div className="space-y-1.5">
                          <Label className="text-xs font-mediumr text-fg-muted">Instance Name</Label>
                          <Input
                            value={instanceName}
                            onChange={(e) => setInstanceName(e.target.value)}
                            placeholder="SQLEXPRESS"
                            className="h-9 bg-panel border-hairline focus:border-orange-500/50 text-xs"
                          />
                          <p className="text-xs text-fg-muted">
                            For named instances (e.g. SQLEXPRESS). Leave empty for default instance.
                          </p>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* SSL/TLS & SSH Panels - only for non-file-based providers */}
          {!isFileBased(type) && (
            <div className="space-y-2">
              {/* SSL/TLS Toggle */}
              <button
                type="button"
                onClick={() => setShowSSL(!showSSL)}
                className="flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-hairline hover:border-hairline-strong bg-panel text-xs font-medium text-fg-tertiary hover:text-fg transition-all"
              >
                <Lock strokeWidth={1.5} className="w-3.5 h-3.5 text-emerald-500" />
                <span>SSL / TLS</span>
                {sslMode !== "disable" && (
                  <span className="ml-1 px-1.5 py-0.5 rounded text-[0.625rem] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    {sslMode.toUpperCase()}
                  </span>
                )}
                <ChevronDown className={cn("w-3 h-3 ml-auto transition-transform", showSSL && "rotate-180")} />
              </button>
              <AnimatePresence>
                {showSSL && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="p-3 rounded-lg border border-emerald-500/10 bg-emerald-500/5 space-y-3">
                      <div className="space-y-2">
                        <Label className="text-xs font-mediumr text-fg-muted">SSL Mode</Label>
                        <div className="flex flex-wrap gap-1.5">
                          {(["disable", "require", "verify-system", "verify-ca", "verify-full"] as SSLMode[]).map(
                            (mode) => (
                              <button
                                key={mode}
                                type="button"
                                onClick={() => setSSLMode(mode)}
                                className={cn(
                                  "px-2.5 py-1.5 rounded-md text-xs font-mediumr transition-all border",
                                  sslMode === mode
                                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                                    : "border-transparent text-fg-muted hover:text-fg-secondary hover:bg-fill",
                                )}
                              >
                                {mode}
                              </button>
                            ),
                          )}
                        </div>
                        <p data-testid="ssl-mode-hint" className="text-xs text-fg-muted">
                          {SSL_MODE_HINTS[sslMode]}
                        </p>
                      </div>
                      {sslMode !== "disable" && (
                        <div className="space-y-3">
                          <div className="space-y-1.5">
                            <Label className="text-xs font-mediumr text-fg-muted">CA Certificate (PEM)</Label>
                            <textarea
                              value={caCert}
                              onChange={(e) => setCaCert(e.target.value)}
                              placeholder="-----BEGIN CERTIFICATE-----&#10;Paste CA cert content here...&#10;-----END CERTIFICATE-----"
                              rows={3}
                              className="w-full rounded-md bg-panel border border-hairline focus:border-emerald-500/50 text-xs font-mono text-fg-secondary p-2 resize-none placeholder:text-fg-subtle"
                            />
                          </div>
                          {(sslMode === "verify-ca" || sslMode === "verify-full") && (
                            <>
                              <div className="space-y-1.5">
                                <Label className="text-xs font-mediumr text-fg-muted">Client Certificate (PEM)</Label>
                                <textarea
                                  value={clientCert}
                                  onChange={(e) => setClientCert(e.target.value)}
                                  placeholder="-----BEGIN CERTIFICATE-----&#10;Optional client cert...&#10;-----END CERTIFICATE-----"
                                  rows={3}
                                  className="w-full rounded-md bg-panel border border-hairline focus:border-emerald-500/50 text-xs font-mono text-fg-secondary p-2 resize-none placeholder:text-fg-subtle"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs font-mediumr text-fg-muted">Client Private Key (PEM)</Label>
                                <textarea
                                  value={clientKey}
                                  onChange={(e) => setClientKey(e.target.value)}
                                  placeholder="-----BEGIN PRIVATE KEY-----&#10;Optional client key...&#10;-----END PRIVATE KEY-----"
                                  rows={3}
                                  className="w-full rounded-md bg-panel border border-hairline focus:border-emerald-500/50 text-xs font-mono text-fg-secondary p-2 resize-none placeholder:text-fg-subtle"
                                />
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* SSH Tunnel Toggle */}
              <button
                type="button"
                onClick={() => setShowSSH(!showSSH)}
                className="flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-hairline hover:border-hairline-strong bg-panel text-xs font-medium text-fg-tertiary hover:text-fg transition-all"
              >
                <Terminal strokeWidth={1.5} className="w-3.5 h-3.5 text-purple-500" />
                <span>SSH Tunnel</span>
                {sshEnabled && (
                  <span className="ml-1 px-1.5 py-0.5 rounded text-[0.625rem] bg-purple-500/10 text-purple-400 border border-purple-500/20">
                    ON
                  </span>
                )}
                <ChevronDown className={cn("w-3 h-3 ml-auto transition-transform", showSSH && "rotate-180")} />
              </button>
              <AnimatePresence>
                {showSSH && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="p-3 rounded-lg border border-purple-500/10 bg-purple-500/5 space-y-3">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={sshEnabled}
                          onChange={(e) => setSSHEnabled(e.target.checked)}
                          className="rounded border-edge bg-panel"
                        />
                        <span className="text-xs font-medium text-fg-secondary">Enable SSH Tunnel</span>
                      </label>
                      {sshEnabled && (
                        <div className="space-y-3">
                          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                            <div className="md:col-span-3 space-y-1.5">
                              <Label className="text-xs font-mediumr text-fg-muted">SSH Host</Label>
                              <Input
                                value={sshHost}
                                onChange={(e) => setSSHHost(e.target.value)}
                                placeholder="bastion.example.com"
                                autoComplete="off"
                                className="h-9 bg-panel border-hairline focus:border-purple-500/50 text-xs"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs font-mediumr text-fg-muted">Port</Label>
                              <Input
                                value={sshPort}
                                onChange={(e) => setSSHPort(e.target.value)}
                                autoComplete="off"
                                className="h-9 bg-panel border-hairline focus:border-purple-500/50 text-xs font-mono"
                              />
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs font-mediumr text-fg-muted">Username</Label>
                            <Input
                              value={sshUsername}
                              onChange={(e) => setSSHUsername(e.target.value)}
                              placeholder="ubuntu"
                              autoComplete="off"
                              className="h-9 bg-panel border-hairline focus:border-purple-500/50 text-xs"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-mediumr text-fg-muted">Auth Method</Label>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => setSSHAuthMethod("password")}
                                className={cn(
                                  "flex-1 px-3 py-1.5 rounded-md text-xs font-mediumr transition-all border",
                                  sshAuthMethod === "password"
                                    ? "border-purple-500/30 bg-purple-500/10 text-purple-400"
                                    : "border-transparent text-fg-muted hover:text-fg-secondary hover:bg-fill",
                                )}
                              >
                                Password
                              </button>
                              <button
                                type="button"
                                onClick={() => setSSHAuthMethod("privateKey")}
                                className={cn(
                                  "flex-1 px-3 py-1.5 rounded-md text-xs font-mediumr transition-all border",
                                  sshAuthMethod === "privateKey"
                                    ? "border-purple-500/30 bg-purple-500/10 text-purple-400"
                                    : "border-transparent text-fg-muted hover:text-fg-secondary hover:bg-fill",
                                )}
                              >
                                Private Key
                              </button>
                            </div>
                          </div>
                          {sshAuthMethod === "password" ? (
                            <div className="space-y-1.5">
                              <Label className="text-xs font-mediumr text-fg-muted">SSH Password</Label>
                              <Input
                                type="password"
                                value={sshPassword}
                                onChange={(e) => setSSHPassword(e.target.value)}
                                placeholder="••••••••"
                                autoComplete="new-password"
                                className="h-9 bg-panel border-hairline focus:border-purple-500/50 text-xs"
                              />
                            </div>
                          ) : (
                            <div className="space-y-3">
                              <div className="space-y-1.5">
                                <Label className="text-xs font-mediumr text-fg-muted">Private Key (PEM)</Label>
                                <textarea
                                  value={sshPrivateKey}
                                  onChange={(e) => setSSHPrivateKey(e.target.value)}
                                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;Paste private key here...&#10;-----END OPENSSH PRIVATE KEY-----"
                                  rows={4}
                                  className="w-full rounded-md bg-panel border border-hairline focus:border-purple-500/50 text-xs font-mono text-fg-secondary p-2 resize-none placeholder:text-fg-subtle"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs font-mediumr text-fg-muted">Passphrase (optional)</Label>
                                <Input
                                  type="password"
                                  value={sshPassphrase}
                                  onChange={(e) => setSSHPassphrase(e.target.value)}
                                  placeholder="Key passphrase (if encrypted)"
                                  autoComplete="new-password"
                                  className="h-9 bg-panel border-hairline focus:border-purple-500/50 text-xs"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Test Result */}
          <AnimatePresence>
            {testResult && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div
                  data-testid="connection-test-result"
                  data-tone={testResult.tone}
                  className={cn(
                    "flex items-center gap-2 p-3 rounded-lg border text-xs",
                    testResult.tone === "success"
                      ? "bg-emerald-500/5 border-emerald-500/20 text-emerald-400"
                      : testResult.tone === "warning"
                        ? "bg-amber-500/5 border-amber-500/20 text-amber-400"
                        : "bg-red-500/5 border-red-500/20 text-red-400",
                  )}
                >
                  {testResult.tone === "success" ? (
                    <CircleCheck strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
                  ) : testResult.tone === "warning" ? (
                    <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
                  ) : (
                    <CircleX strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <span className="leading-relaxed">{testResult.message}</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Sticky footer */}
      <div className="shrink-0 bg-panel p-4 md:p-6 border-t border-hairline">
        <div className="flex flex-col-reverse gap-3 md:flex-row md:items-center md:justify-between">
          <Button
            variant="ghost"
            onClick={onClose}
            className="w-full md:w-auto text-fg-muted hover:text-fg hover:bg-fill text-xs font-medium"
          >
            Cancel
          </Button>
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-2">
            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={isTesting}
              className="w-full md:w-auto border-hairline-strong text-fg-tertiary hover:text-fg-bright hover:bg-fill text-xs font-medium h-10 px-4"
            >
              {isTesting ? (
                <div className="flex items-center gap-2">
                  {/* On an outline button, so the spinner follows the text ramp. */}
                  <div className="w-3 h-3 border-2 border-fg-tertiary/30 border-t-fg-tertiary rounded-full animate-spin" />
                  Testing...
                </div>
              ) : (
                "Test Connection"
              )}
            </Button>
            <Button
              onClick={handleConnect}
              disabled={
                isTesting ||
                (getDBConfig(type).showConnectionStringToggle &&
                  mongoConnectionMode === "connectionString" &&
                  !connectionString.trim())
              }
              className="w-full md:w-auto min-w-0 md:min-w-[140px] bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs h-10 shadow-lg shadow-blue-900/20 group relative overflow-hidden"
            >
              <AnimatePresence mode="wait">
                {isTesting ? (
                  <motion.div
                    key="testing"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="flex items-center gap-2"
                  >
                    {/* Inside a solid blue button — white is right on either ground. */}
                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Connecting...
                  </motion.div>
                ) : (
                  <motion.div
                    key="connect"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="flex items-center gap-2"
                  >
                    {isEditMode ? "Save Changes" : "Establish Connection"}
                  </motion.div>
                )}
              </AnimatePresence>
            </Button>
          </div>
        </div>
      </div>
    </>
  );

  if (isMobile) {
    return (
      <Drawer
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DrawerContent className="max-h-[95dvh] bg-surface border-hairline text-fg p-0 flex flex-col">
          <DrawerHeader className="sr-only">
            <DrawerTitle>{isEditMode ? "Edit Connection" : "New Connection"}</DrawerTitle>
            <DrawerDescription>Configure database connection parameters.</DrawerDescription>
          </DrawerHeader>
          {formContent}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="sm:max-w-[500px] lg:max-w-[540px] max-h-[90vh] bg-surface border-hairline text-fg p-0 overflow-hidden shadow-2xl flex flex-col"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{isEditMode ? "Edit Connection" : "New Connection"}</DialogTitle>
        <DialogDescription className="sr-only">Configure database connection parameters.</DialogDescription>
        {formContent}
      </DialogContent>
    </Dialog>
  );
}
