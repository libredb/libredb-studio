"use client";

import { useRef, useState } from "react";
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
  Zap,
  Globe,
  Link,
  CircleCheck,
  CircleX,
  TriangleAlert,
  ClipboardPaste,
  Lock,
  ChevronDown,
  Terminal,
  Settings2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  connectionFieldLabel,
  connectionFieldPlaceholder,
  getDBConfig,
  isFileBased,
  offersSshTunnel,
  offersSslPanel,
  readOnlyHint,
  type ConnectionField,
} from "@/lib/db-ui-config";
import type { BodyConnectionField } from "@/lib/db/connection-fields";
import { connectionFormLayout } from "@/lib/db/connection-field-layout";
import {
  ConnectionFieldControl,
  ConnectionFieldGroupRow,
  DeclaredFieldHint,
  describedByHint,
  fieldHintId,
} from "@/components/ConnectionFieldControl";
import { motion, AnimatePresence } from "framer-motion";
import { CONNECTION_FORM_DEFAULTS, useConnectionForm } from "@/hooks/use-connection-form";
import { useIsMobile } from "@/hooks/use-mobile";
import { WireCompatibilityHint } from "@/components/WireCompatibilityHint";
import { ConnectionImportPanel } from "@/components/ConnectionImportPanel";
import { PASTE_FORMATS_TEXT } from "@/lib/connection-paste-formats";

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

/**
 * The id of the Host box's refusal, drawn right under the box so the person sees why an address was not split
 * without scrolling to the result banner, which repeats it.
 */
const HOST_ERROR_ID = "host-error";

/**
 * A statement that fixes a refusal, under the refusal's sentence: monospace, wrapped anywhere so a long key never
 * scrolls the dialog sideways, with a Copy button that writes exactly the statement. The sentence above still holds
 * the statement, so a host that shows only the message loses nothing.
 */
function FixStatement({ statement }: { readonly statement: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <pre
        data-testid="connection-fix-statement"
        className="whitespace-pre-wrap break-all rounded-md border border-hairline bg-panel p-2 font-mono text-xs text-fg"
      >
        {statement}
      </pre>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(statement).then(() => setCopied(true));
          }}
          className="h-7 px-3 text-xs"
        >
          Copy
        </Button>
        <output data-testid="connection-fix-statement-copied" className="text-xs text-fg-muted">
          {copied ? "Copied" : ""}
        </output>
      </div>
    </div>
  );
}

interface ConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (conn: DatabaseConnection) => void;
  editConnection?: DatabaseConnection | null;
  /** Optional API adapter: when provided, bypasses the built-in /api/db/test-connection fetch. */
  onTestConnection?: (
    connection: DatabaseConnection,
  ) => Promise<{ success: boolean; latency?: number; error?: string; fixStatement?: string }>;
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
    takeHostAddress,
    settleHost,
    hostError,
    port,
    setPort,
    database,
    setDatabase,
    queryTimeout,
    setQueryTimeout,
    skipObjectScan,
    setSkipObjectScan,
    readOnly,
    setReadOnly,
    allowInsecureAuth,
    setAllowInsecureAuth,
    connectionString,
    setConnectionString,
    mongoConnectionMode,
    setMongoConnectionMode,
    environment,
    setEnvironment,
    // Every other field, by name, for the one field renderer
    fieldValues,
    setFieldValue,

    // UI state
    isTesting,
    testResult,
    setTestResult,
    withdrawResult,
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

    // Advanced
    showAdvanced,
    setShowAdvanced,

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
    applyImported,

    // Derived data
    dbTypes,
    readOnlyOffered,
    credentialWarning,
  } = useConnectionForm({
    isOpen,
    onClose,
    onConnect,
    editConnection,
    onTestConnection,
  });

  // What an engine DECLARES for a connection field wins over this dialog's own words (#1085): an
  // engine that names a field differently says so on `DatabaseUIConfig` instead of growing an
  // `isX` branch here. An engine that declares nothing reads the dialog's own words below.
  const uiConfig = getDBConfig(type);
  /**
   * The body's rows, from the engine's declared fields and their descriptors (src/lib/db/connection-field-layout.ts):
   * the dialog draws the address row itself and maps every other field through the one renderer, so it never asks
   * whether this engine takes a given field. A field shown under a condition (`fieldShownWhen`) is drawn while the
   * form's own values meet it, the rule `buildConnection` writes by.
   */
  const layout = connectionFormLayout(uiConfig, fieldValues);
  const takesInsecureAuthConsent = layout.takesInsecureAuthConsent;
  /** Whether this engine's address has a port of its own, beside the host box. */
  const takesPort = layout.takesPort;
  /** The answer panel, so the press that produced it can bring it on screen (below). */
  const testResultRef = useRef<HTMLDivElement | null>(null);
  const databaseLabel = connectionFieldLabel(uiConfig, "database", "Database Name");
  // The port box shares the Host row's label; an engine that declares a port label of its own gets it drawn above the
  // box, and every other engine's row stays as it was.
  const portLabel = connectionFieldLabel(uiConfig, "port", "");
  const portBox = (
    <Input
      id="port"
      value={port}
      onChange={(e) => setPort(e.target.value)}
      autoComplete="off"
      aria-describedby={describedByHint(uiConfig, "port")}
      className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs font-mono"
    />
  );

  const derivedHostHint = uiConfig.hostHint?.(host);
  /**
   * A field Test refuses empty (its declared rule has `required`), marked on its label with an asterisk drawn by CSS,
   * so the label's text stays the field's name, and on its box with `aria-required` (SF-043).
   */
  const isRequired = (field: ConnectionField): boolean => uiConfig.fieldRules?.[field]?.required !== undefined;
  const labelClass = (field: ConnectionField): string =>
    cn("text-xs font-medium text-fg-muted", isRequired(field) && "after:ml-0.5 after:text-danger after:content-['*']");
  const requiredProps = (field: ConnectionField) => (isRequired(field) ? { "aria-required": true as const } : {});

  /** One field the engine declares, drawn by its descriptor. */
  const fieldControl = (field: BodyConnectionField) => (
    <ConnectionFieldControl
      key={field}
      config={uiConfig}
      field={field}
      value={fieldValues[field]}
      onChange={setFieldValue}
      credentialWarning={credentialWarning}
    />
  );

  const formContent = (
    <>
      {/* Progress bar — fixed top */}
      <div className="shrink-0 h-2 w-full bg-brand-solid/20">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: "100%" }}
          className="h-full bg-brand-tint shadow-[0_0_15px_rgba(59,130,246,0.5)]"
        />
      </div>

      {/*
        Scrollable body. A change to any field in it withdraws the result banner (SF-043): a Test result describes the
        fields it ran on, and stood beside a changed key or user as if it still did.
      */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8" onChangeCapture={withdrawResult}>
        <div className="mb-4 md:mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-xl bg-brand-tint/10 border border-brand-tint/20">
              <Zap strokeWidth={1.5} className="w-5 h-5 text-brand" />
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
                className="flex items-center gap-1.5 text-xs font-medium text-brand hover:text-brand-bright transition-colors px-2 py-1 rounded-md hover:bg-brand-tint/10"
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
              <div className="p-3 rounded-lg border border-brand-tint/20 bg-brand-tint/5 space-y-2">
                <Label className="text-xs font-medium text-brand">Paste Connection URL</Label>
                <div className="flex gap-2">
                  <Input
                    value={pasteInput}
                    onChange={(e) => setPasteInput(e.target.value)}
                    placeholder="postgres://user:pass@host:5432/db  or  mongodb://...  or  databend://..."
                    // A pasted URL can carry a password or a token: never offered back by the browser, never spell-checked.
                    autoComplete="off"
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                    className="h-9 bg-panel border-hairline focus:border-brand-tint/50 text-xs font-mono flex-1"
                    onKeyDown={(e) => e.key === "Enter" && handlePasteConnectionString()}
                  />
                  <Button
                    size="sm"
                    onClick={handlePasteConnectionString}
                    className="bg-brand-solid hover:bg-brand-solid-hover text-white h-9 px-4 text-xs font-medium"
                  >
                    Parse
                  </Button>
                </div>
                <p data-testid="paste-formats" className="text-xs text-fg-muted">
                  Supports: {PASTE_FORMATS_TEXT}
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
              <Label htmlFor="name" className="text-xs font-medium text-fg-muted">
                Connection Name
              </Label>
            </div>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Database"
              className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="queryTimeout" className="text-xs font-medium text-fg-muted">
              Query Timeout (ms)
            </Label>
            <Input
              id="queryTimeout"
              type="number"
              min={1}
              max={2147483647}
              step={1}
              value={queryTimeout}
              onChange={(e) => setQueryTimeout(e.target.value)}
              placeholder="60000"
              aria-describedby="queryTimeout-hint"
              className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs"
            />
            <p id="queryTimeout-hint" className="text-xs text-fg-muted">
              Leave blank to use the default of 60 seconds.
            </p>
          </div>

          {/*
            The no-scan escape hatch (#765). Beside the timeout rather than behind the
            Advanced accordion, and not gated on the engine: every engine has a catalog,
            and the connection that holds tens of thousands of objects is the one that
            knows it does.
          */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                id="skipObjectScan"
                type="checkbox"
                checked={skipObjectScan}
                onChange={(e) => setSkipObjectScan(e.target.checked)}
                aria-describedby="skipObjectScan-hint"
                className="rounded border-edge bg-panel"
              />
              <span className="text-xs font-medium text-fg-muted">Do not read the object list on connect</span>
            </label>
            <p id="skipObjectScan-hint" className="text-xs text-fg-muted">
              The editor still works. The object panel offers a load action instead.
            </p>
          </div>

          {/*
            The read-only mode (#1089), drawn only where the form offers it: an engine whose provider
            enforces the mode, and never a copy of a seed, whose mode the server re-resolves from the
            operator's file. Beside the no-scan choice, because it too is about what this connection
            does rather than how it is reached.
          */}
          {readOnlyOffered && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  id="readOnly"
                  type="checkbox"
                  checked={readOnly}
                  onChange={(e) => setReadOnly(e.target.checked)}
                  aria-describedby="readOnly-hint"
                  className="rounded border-edge bg-panel"
                />
                <span className="text-xs font-medium text-fg-muted">Read-only</span>
              </label>
              <p id="readOnly-hint" className="text-xs text-fg-muted">
                {readOnlyHint(uiConfig)}
              </p>
            </div>
          )}

          {/* Environment Selector */}
          <div className="space-y-2">
            <Label className="text-xs font-medium text-fg-muted">Environment</Label>
            <div className="flex flex-wrap items-center gap-2">
              {(Object.keys(ENVIRONMENT_COLORS) as ConnectionEnvironment[]).map((env) => (
                <button
                  key={env}
                  onClick={() => setEnvironment(env)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all border",
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
                  /*
                   * `localhost` IS NOT AN ENDPOINT URL, and this box held it. An engine whose whole
                   * address is one URL - OPC UA is the only one that takes a host without a port -
                   * was offered the generic host default, so a reader who picked it, typed nothing
                   * and pressed Test Connection was refused for a value Studio put there. Measured
                   * in a browser: the box read `localhost` under the label "Endpoint URL", beside a
                   * placeholder showing `opc.tcp://plc.example.net:4840/`. Only the UNTOUCHED default
                   * is cleared, so nothing a reader typed is lost, and it comes back when they pick
                   * an engine that is addressed by host and port.
                   */
                  const addressIsOneUrl = !connectionFormLayout(cfg, {}).takesPort;
                  if (addressIsOneUrl && host === CONNECTION_FORM_DEFAULTS.host) setHost("");
                  if (!addressIsOneUrl && host === "") setHost(CONNECTION_FORM_DEFAULTS.host);
                  setTestResult(null);
                }}
                disabled={isEditMode}
                /*
                 * WHICH ENGINE IS CHOSEN IS SAID, not only drawn. The chosen card is a tint and a
                 * glow and nothing else, so a screen reader was told the grid holds 33 buttons and
                 * nothing about which one is active - found by reading the accessibility tree of the
                 * dialog. The security-mode buttons three fields below already answer this way.
                 */
                aria-pressed={type === db.value}
                className={cn(
                  "flex flex-col items-center justify-center p-3 md:p-4 rounded-xl border transition-all duration-200 gap-2 group",
                  type === db.value
                    ? "bg-brand-solid/10 border-brand-tint/50 shadow-[0_0_20px_rgba(59,130,246,0.1)]"
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

          {/*
            The import the selected engine declares, read from its entry rather than an isX branch, and only for a
            new connection. Keyed by the type, so a switch to another engine drops whatever the import had read.
          */}
          {!isEditMode && uiConfig.connectionImport !== undefined && (
            <ConnectionImportPanel key={type} declaration={uiConfig.connectionImport} onApply={applyImported} />
          )}

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
                        ? "bg-brand-solid/20 text-brand border border-brand-tint/30"
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
                        ? "bg-brand-solid/20 text-brand border border-brand-tint/30"
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
                      <Label htmlFor="connectionString" className="text-xs font-medium text-fg-muted">
                        {connectionFieldLabel(uiConfig, "connectionString", "Connection URI")}
                      </Label>
                    </div>
                    <Input
                      id="connectionString"
                      value={connectionString}
                      onChange={(e) => setConnectionString(e.target.value)}
                      placeholder={connectionFieldPlaceholder(uiConfig, "connectionString", "")}
                      autoComplete="off"
                      spellCheck={false}
                      autoCorrect="off"
                      autoCapitalize="off"
                      aria-describedby={describedByHint(uiConfig, "connectionString")}
                      className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs font-mono"
                    />
                    <DeclaredFieldHint config={uiConfig} field="connectionString" />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 mb-1">
                      <Database strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                      <Label htmlFor="database" className="text-xs font-medium text-fg-muted">
                        {databaseLabel} (optional override)
                      </Label>
                    </div>
                    <Input
                      id="database"
                      value={database}
                      onChange={(e) => setDatabase(e.target.value)}
                      placeholder="Extracted from URI if not provided"
                      aria-describedby={describedByHint(uiConfig, "database")}
                      className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs font-mono"
                    />
                    <DeclaredFieldHint config={uiConfig} field="database" />
                  </div>
                </>
              ) : isFileBased(type) ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 mb-1">
                    <Database strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                    <Label htmlFor="database" className="text-xs font-medium text-fg-muted">
                      {connectionFieldLabel(uiConfig, "database", "Database File Path")}
                    </Label>
                  </div>
                  <Input
                    id="database"
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    placeholder="/path/to/database file"
                    aria-describedby={describedByHint(uiConfig, "database")}
                    className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs font-mono"
                  />
                  <DeclaredFieldHint config={uiConfig} field="database" />
                </div>
              ) : (
                <>
                  {/*
                    The body in the engine's own order (src/lib/db/connection-field-layout.ts): the address row the
                    dialog draws itself, and every other field through the one renderer, alone or in a row, so a box
                    exists exactly where `buildConnection` writes a value and nowhere else.
                  */}
                  {layout.body.map((slot) => {
                    if (slot.kind === "address") {
                      return (
                        <div key="address" className="space-y-2">
                          <div className="flex items-center gap-2 mb-1">
                            <Globe strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                            <Label htmlFor="host" className={labelClass("host")}>
                              {connectionFieldLabel(uiConfig, "host", "Host & Instance")}
                            </Label>
                          </div>
                          <div className={cn("grid grid-cols-1 md:grid-cols-4 gap-3", portLabel !== "" && "items-end")}>
                            <Input
                              id="host"
                              {...requiredProps("host")}
                              value={host}
                              onChange={(e) => setHost(e.target.value, (e.nativeEvent as InputEvent).inputType)}
                              onBlur={settleHost}
                              onPaste={(e) => {
                                if (takeHostAddress(e.clipboardData.getData("text/plain"))) e.preventDefault();
                              }}
                              onDrop={(e) => {
                                if (takeHostAddress(e.dataTransfer.getData("text/plain"))) e.preventDefault();
                              }}
                              // An engine whose address is not a bare host name says so: OPC UA's whole
                              // address is one endpoint URL, and "localhost" would be a wrong example.
                              placeholder={connectionFieldPlaceholder(uiConfig, "host", "localhost")}
                              // An engine's Host box can take a pasted URL, Snowflake's an account URL among them.
                              autoComplete="off"
                              /*
                               * AN ADDRESS IS NOT PROSE. A host box is never spell checked, corrected or
                               * capitalised by the browser, and on an engine whose whole address is a URL
                               * it is also a field that could carry a credential - which is why
                               * `tests/components/ConnectionModal-secret-fields.test.tsx` holds every box
                               * whose placeholder contains `://` to the same rule as a password.
                               */
                              spellCheck={false}
                              autoCorrect="off"
                              autoCapitalize="off"
                              aria-invalid={hostError === undefined ? undefined : true}
                              aria-describedby={
                                [
                                  derivedHostHint === undefined
                                    ? describedByHint(uiConfig, "host")
                                    : fieldHintId("host"),
                                  hostError === undefined ? undefined : HOST_ERROR_ID,
                                ]
                                  .filter((id) => id !== undefined)
                                  .join(" ") || undefined
                              }
                              className={cn(
                                "h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs",
                                takesPort ? "md:col-span-3" : "md:col-span-4",
                              )}
                            />
                            {/*
                                THE PORT BOX IS DRAWN ONLY WHERE THE ENGINE TAKES ONE, by the same rule as
                                every other field rather than for every engine with a host. OPC UA's whole
                                address is one endpoint URL, which carries its own port, and this box was
                                drawn beside it holding 4840: measured in a browser, a reader could type
                                54840 into it and the dial went to the port in the URL, so the box offered a
                                correction it could not make. The host takes the full row where it is gone,
                                and an engine that declares a port label of its own still gets it. Snowflake
                                takes none either: an account is reached on 443 alone.
                              */}
                            {takesPort &&
                              (portLabel === "" ? (
                                portBox
                              ) : (
                                <div className="space-y-2">
                                  <Label htmlFor="port" className="text-xs font-medium text-fg-muted">
                                    {portLabel}
                                  </Label>
                                  {portBox}
                                </div>
                              ))}
                          </div>
                          {hostError !== undefined && (
                            <p
                              id={HOST_ERROR_ID}
                              data-testid={HOST_ERROR_ID}
                              role="alert"
                              className="text-xs text-danger"
                            >
                              {hostError}
                            </p>
                          )}
                          {/* The host the typed text derives, where the engine declares a reader for it; else the static hint. */}
                          {derivedHostHint === undefined ? (
                            <DeclaredFieldHint config={uiConfig} field="host" />
                          ) : (
                            <p
                              id={fieldHintId("host")}
                              data-testid={fieldHintId("host")}
                              className="text-xs text-fg-muted"
                            >
                              {derivedHostHint}
                            </p>
                          )}
                          {takesPort && <DeclaredFieldHint config={uiConfig} field="port" />}
                        </div>
                      );
                    }
                    if (slot.kind === "group") {
                      return (
                        <ConnectionFieldGroupRow
                          key={slot.group}
                          config={uiConfig}
                          group={slot.group}
                          fields={slot.fields}
                          values={fieldValues}
                          onChange={setFieldValue}
                          credentialWarning={credentialWarning}
                        />
                      );
                    }
                    return fieldControl(slot.field);
                  })}
                </>
              )}
            </>
          </div>

          {/* Advanced Settings: drawn for an engine that places a field behind it (`fieldPlacement`). */}
          {layout.advanced.length > 0 && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-hairline hover:border-hairline-strong bg-panel text-xs font-medium text-fg-tertiary hover:text-fg transition-all"
              >
                <Settings2 strokeWidth={1.5} className="w-3.5 h-3.5 text-hue-orange" />
                <span>Advanced</span>
                {layout.advanced.some((field) => fieldValues[field] !== "") && (
                  <span className="ml-1 px-1.5 py-0.5 rounded text-[0.625rem] bg-hue-orange-tint/10 text-hue-orange border border-hue-orange-tint/20">
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
                    <div className="p-3 rounded-lg border border-hue-orange-tint/10 bg-hue-orange-tint/5 space-y-3">
                      {layout.advanced.map(fieldControl)}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* SSL/TLS & SSH Panels - only for non-file-based providers, each half only where offered */}
          {!isFileBased(type) && (offersSslPanel(type) || offersSshTunnel(type) || takesInsecureAuthConsent) && (
            <div className="space-y-2">
              {offersSslPanel(type) && (
                <>
                  {/* SSL/TLS Toggle */}
                  <button
                    type="button"
                    onClick={() => setShowSSL(!showSSL)}
                    className="flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-hairline hover:border-hairline-strong bg-panel text-xs font-medium text-fg-tertiary hover:text-fg transition-all"
                  >
                    <Lock strokeWidth={1.5} className="w-3.5 h-3.5 text-hue-emerald" />
                    <span>SSL / TLS</span>
                    {sslMode !== "disable" && (
                      <span className="ml-1 px-1.5 py-0.5 rounded text-[0.625rem] bg-hue-emerald-tint/10 text-hue-emerald border border-hue-emerald-tint/20">
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
                        <div className="p-3 rounded-lg border border-hue-emerald-tint/10 bg-hue-emerald-tint/5 space-y-3">
                          <div className="space-y-2">
                            <Label className="text-xs font-medium text-fg-muted">SSL Mode</Label>
                            <div className="flex flex-wrap gap-1.5">
                              {(["disable", "require", "verify-system", "verify-ca", "verify-full"] as SSLMode[]).map(
                                (mode) => (
                                  <button
                                    key={mode}
                                    type="button"
                                    onClick={() => setSSLMode(mode)}
                                    className={cn(
                                      "px-2.5 py-1.5 rounded-md text-xs font-medium transition-all border",
                                      sslMode === mode
                                        ? "border-hue-emerald-tint/30 bg-hue-emerald-tint/10 text-hue-emerald"
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
                                <Label className="text-xs font-medium text-fg-muted">CA Certificate (PEM)</Label>
                                <textarea
                                  value={caCert}
                                  onChange={(e) => setCaCert(e.target.value)}
                                  placeholder="-----BEGIN CERTIFICATE-----&#10;Paste CA cert content here...&#10;-----END CERTIFICATE-----"
                                  autoComplete="off"
                                  spellCheck={false}
                                  autoCorrect="off"
                                  autoCapitalize="off"
                                  rows={3}
                                  className="w-full rounded-md bg-panel border border-hairline focus:border-hue-emerald-tint/50 text-xs font-mono text-fg-secondary p-2 resize-none placeholder:text-fg-subtle"
                                />
                              </div>
                              {(sslMode === "verify-ca" || sslMode === "verify-full") && (
                                <>
                                  <div className="space-y-1.5">
                                    <Label className="text-xs font-medium text-fg-muted">
                                      Client Certificate (PEM)
                                    </Label>
                                    <textarea
                                      value={clientCert}
                                      onChange={(e) => setClientCert(e.target.value)}
                                      placeholder="-----BEGIN CERTIFICATE-----&#10;Optional client cert...&#10;-----END CERTIFICATE-----"
                                      autoComplete="off"
                                      spellCheck={false}
                                      autoCorrect="off"
                                      autoCapitalize="off"
                                      rows={3}
                                      className="w-full rounded-md bg-panel border border-hairline focus:border-hue-emerald-tint/50 text-xs font-mono text-fg-secondary p-2 resize-none placeholder:text-fg-subtle"
                                    />
                                  </div>
                                  <div className="space-y-1.5">
                                    <Label className="text-xs font-medium text-fg-muted">
                                      Client Private Key (PEM)
                                    </Label>
                                    <textarea
                                      value={clientKey}
                                      onChange={(e) => setClientKey(e.target.value)}
                                      placeholder="-----BEGIN PRIVATE KEY-----&#10;Optional client key...&#10;-----END PRIVATE KEY-----"
                                      autoComplete="off"
                                      spellCheck={false}
                                      autoCorrect="off"
                                      autoCapitalize="off"
                                      rows={3}
                                      className="w-full rounded-md bg-panel border border-hairline focus:border-hue-emerald-tint/50 text-xs font-mono text-fg-secondary p-2 resize-none placeholder:text-fg-subtle"
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
                </>
              )}

              {/*
                The consent to a cleartext password (#786), outside the accordion so it is seen while
                SSL Mode is disable: the provider of a type that takes it refuses such a connection
                without it, and the refusal names this box. The sentence under it is the type's own
                declared hint (InfluxDB spec R4), never a fallback; tests/unit/lib/db-ui-config.test.ts
                holds every type that takes the field to declaring one.
              */}
              {takesInsecureAuthConsent && sslMode === "disable" && (
                <div className="space-y-1 p-3 rounded-lg border border-warning-tint/10 bg-warning-tint/5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      id="allowInsecureAuth"
                      type="checkbox"
                      checked={allowInsecureAuth}
                      onChange={(e) => setAllowInsecureAuth(e.target.checked)}
                      aria-describedby={describedByHint(uiConfig, "allowInsecureAuth")}
                      className="rounded border-edge bg-panel"
                    />
                    <span className="text-xs font-medium text-warning">
                      {connectionFieldLabel(uiConfig, "allowInsecureAuth", "Send the password without TLS")}
                    </span>
                  </label>
                  <DeclaredFieldHint config={uiConfig} field="allowInsecureAuth" />
                </div>
              )}

              {/*
                The SSH half only where the engine offers a tunnel (#1088). A Kafka client reaches
                every broker at the address that broker advertises, which a tunnel does not carry,
                so its TLS panel above stays and this does not; `buildConnection` reads the same
                rule, so a tunnel switched on under another engine is not sent either.
              */}
              {offersSshTunnel(type) && (
                <>
                  {/* SSH Tunnel Toggle */}
                  <button
                    type="button"
                    onClick={() => setShowSSH(!showSSH)}
                    className="flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-hairline hover:border-hairline-strong bg-panel text-xs font-medium text-fg-tertiary hover:text-fg transition-all"
                  >
                    <Terminal strokeWidth={1.5} className="w-3.5 h-3.5 text-hue-purple" />
                    <span>SSH Tunnel</span>
                    {sshEnabled && (
                      <span className="ml-1 px-1.5 py-0.5 rounded text-[0.625rem] bg-hue-purple-tint/10 text-hue-purple border border-hue-purple-tint/20">
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
                        <div className="p-3 rounded-lg border border-hue-purple-tint/10 bg-hue-purple-tint/5 space-y-3">
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
                                  <Label className="text-xs font-medium text-fg-muted">SSH Host</Label>
                                  <Input
                                    value={sshHost}
                                    onChange={(e) => setSSHHost(e.target.value)}
                                    placeholder="bastion.example.com"
                                    autoComplete="off"
                                    className="h-9 bg-panel border-hairline focus:border-hue-purple-tint/50 text-xs"
                                  />
                                </div>
                                <div className="space-y-1.5">
                                  <Label className="text-xs font-medium text-fg-muted">Port</Label>
                                  <Input
                                    value={sshPort}
                                    onChange={(e) => setSSHPort(e.target.value)}
                                    autoComplete="off"
                                    className="h-9 bg-panel border-hairline focus:border-hue-purple-tint/50 text-xs font-mono"
                                  />
                                </div>
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs font-medium text-fg-muted">Username</Label>
                                <Input
                                  value={sshUsername}
                                  onChange={(e) => setSSHUsername(e.target.value)}
                                  placeholder="ubuntu"
                                  autoComplete="off"
                                  className="h-9 bg-panel border-hairline focus:border-hue-purple-tint/50 text-xs"
                                />
                              </div>
                              <div className="space-y-2">
                                <Label className="text-xs font-medium text-fg-muted">Auth Method</Label>
                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setSSHAuthMethod("password")}
                                    className={cn(
                                      "flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all border",
                                      sshAuthMethod === "password"
                                        ? "border-hue-purple-tint/30 bg-hue-purple-tint/10 text-hue-purple"
                                        : "border-transparent text-fg-muted hover:text-fg-secondary hover:bg-fill",
                                    )}
                                  >
                                    Password
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setSSHAuthMethod("privateKey")}
                                    className={cn(
                                      "flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all border",
                                      sshAuthMethod === "privateKey"
                                        ? "border-hue-purple-tint/30 bg-hue-purple-tint/10 text-hue-purple"
                                        : "border-transparent text-fg-muted hover:text-fg-secondary hover:bg-fill",
                                    )}
                                  >
                                    Private Key
                                  </button>
                                </div>
                              </div>
                              {sshAuthMethod === "password" ? (
                                <div className="space-y-1.5">
                                  <Label className="text-xs font-medium text-fg-muted">SSH Password</Label>
                                  <Input
                                    type="password"
                                    value={sshPassword}
                                    onChange={(e) => setSSHPassword(e.target.value)}
                                    placeholder="••••••••"
                                    autoComplete="new-password"
                                    spellCheck={false}
                                    autoCorrect="off"
                                    autoCapitalize="off"
                                    className="h-9 bg-panel border-hairline focus:border-hue-purple-tint/50 text-xs"
                                  />
                                </div>
                              ) : (
                                <div className="space-y-3">
                                  <div className="space-y-1.5">
                                    <Label className="text-xs font-medium text-fg-muted">Private Key (PEM)</Label>
                                    <textarea
                                      value={sshPrivateKey}
                                      onChange={(e) => setSSHPrivateKey(e.target.value)}
                                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;Paste private key here...&#10;-----END OPENSSH PRIVATE KEY-----"
                                      autoComplete="off"
                                      spellCheck={false}
                                      autoCorrect="off"
                                      autoCapitalize="off"
                                      rows={4}
                                      className="w-full rounded-md bg-panel border border-hairline focus:border-hue-purple-tint/50 text-xs font-mono text-fg-secondary p-2 resize-none placeholder:text-fg-subtle"
                                    />
                                  </div>
                                  <div className="space-y-1.5">
                                    <Label className="text-xs font-medium text-fg-muted">Passphrase (optional)</Label>
                                    <Input
                                      type="password"
                                      value={sshPassphrase}
                                      onChange={(e) => setSSHPassphrase(e.target.value)}
                                      placeholder="Key passphrase (if encrypted)"
                                      autoComplete="new-password"
                                      spellCheck={false}
                                      autoCorrect="off"
                                      autoCapitalize="off"
                                      className="h-9 bg-panel border-hairline focus:border-hue-purple-tint/50 text-xs"
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
                </>
              )}
            </div>
          )}

          {/*
            THE ANSWER COMES TO THE PRESS. This panel is the last child of the dialog's SCROLLING
            body while the buttons that produce it are pinned to the bottom, so on a form as long as
            this one the answer was painted under the footer: measured in a browser on OPC UA, 24 of
            its 163 pixels were on screen and not one character was readable, at every window size
            and in both themes - the reader pressed Test Connection and the screen did not change.
            It is not this engine's defect (the same measurement reproduces on Redis and MQTT), and
            it is the only feedback the connect path has, so it is fixed here rather than recorded:
            when a result arrives, the panel scrolls itself into view.
          */}
          <AnimatePresence>
            {testResult && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                /*
                 * WHEN IT HAS A HEIGHT, not when it mounts. The panel opens from `height: 0`, so a
                 * scroll on mount aims at a box of no height at the very bottom of the body and
                 * lands it right back under the footer - which is what the first attempt at this did,
                 * measured in a browser: the press still looked like nothing happened. Framer's own
                 * completion callback is the moment the box is the size the reader will read.
                 */
                onAnimationComplete={() =>
                  // `block: "center"` rather than `nearest`: the footer overlays the body's last
                  // scroll position, so "just inside the viewport" is still behind the buttons.
                  // INSTANT, not smooth: a smooth scroll is still travelling when the reader (and a
                  // screenshot) looks, which is how the first two attempts at this still showed a
                  // dialog that had not moved.
                  testResultRef.current?.scrollIntoView({ block: "end", behavior: "auto" })
                }
                className="overflow-hidden"
              >
                <div
                  ref={testResultRef}
                  data-testid="connection-test-result"
                  data-tone={testResult.tone}
                  className={cn(
                    // `scroll-mb-28` is what keeps the scroll above the PINNED FOOTER: the footer
                    // overlays the bottom of the scrolling body, so an element scrolled flush to the
                    // container's bottom edge is still behind the buttons - measured, the answer
                    // landed at y=618 of a 720 window with the footer starting near 600, inside the
                    // window and unreadable. The margin is the footer's height and a little over.
                    "scroll-mb-28 flex items-center gap-2 p-3 rounded-lg border text-xs",
                    testResult.tone === "success"
                      ? "bg-success-tint/5 border-success-tint/20 text-success"
                      : testResult.tone === "warning"
                        ? "bg-warning-tint/5 border-warning-tint/20 text-warning"
                        : "bg-danger-tint/5 border-danger-tint/20 text-danger",
                  )}
                >
                  {testResult.tone === "success" ? (
                    <CircleCheck strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
                  ) : testResult.tone === "warning" ? (
                    <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
                  ) : (
                    <CircleX strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1 space-y-2">
                    {/*
                      A block that breaks a word longer than the line: a key-pair refusal carries a fingerprint and
                      public-key bodies with no space in them, which the banner's overflow-hidden parent would clip.
                    */}
                    <p data-testid="connection-test-message" className="leading-relaxed break-words">
                      {testResult.message}
                    </p>
                    {testResult.fixStatement !== undefined && <FixStatement statement={testResult.fixStatement} />}
                  </div>
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
              className="w-full md:w-auto min-w-0 md:min-w-[140px] bg-brand-solid hover:bg-brand-solid-hover text-white font-medium text-xs h-10 shadow-lg shadow-blue-900/20 group relative overflow-hidden"
            >
              {/*
                The label follows isTesting in the same render, never through an exit animation: AnimatePresence
                in "wait" mode kept "Connecting..." on this button until its fade-out ended, after the answer was
                already on screen (measured 2026-10-11 against a host that drops the packets).
              */}
              {isTesting ? (
                <div className="flex items-center gap-2">
                  {/* Inside a solid blue button: white is right on either ground. */}
                  <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Connecting...
                </div>
              ) : (
                <div className="flex items-center gap-2">{isEditMode ? "Save Changes" : "Establish Connection"}</div>
              )}
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
