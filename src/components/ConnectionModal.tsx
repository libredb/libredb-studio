"use client";

import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from '@/components/ui/drawer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DatabaseConnection, ConnectionEnvironment, ENVIRONMENT_COLORS, ENVIRONMENT_LABELS, SSLMode } from '@/lib/types';
import { Database, ShieldCheck, Zap, Globe, Key, Link, CheckCircle2, XCircle, ClipboardPaste, Lock, ChevronDown, Terminal, Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getDBConfig } from '@/lib/db-ui-config';
import { motion, AnimatePresence } from 'framer-motion';
import { useConnectionForm } from '@/hooks/use-connection-form';
import { useIsMobile } from '@/hooks/use-mobile';

interface ConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (conn: DatabaseConnection) => void;
  editConnection?: DatabaseConnection | null;
  /** Optional API adapter: when provided, bypasses the built-in /api/db/test-connection fetch. */
  onTestConnection?: (connection: DatabaseConnection) => Promise<{ success: boolean; latency?: number; error?: string }>;
}

export function ConnectionModal({ isOpen, onClose, onConnect, editConnection, onTestConnection }: ConnectionModalProps) {
  const isMobile = useIsMobile();
  const {
    // Connection fields
    type, setType,
    name, setName,
    host, setHost,
    port, setPort,
    user, setUser,
    password, setPassword,
    database, setDatabase,
    connectionString, setConnectionString,
    mongoConnectionMode, setMongoConnectionMode,
    environment, setEnvironment,

    // UI state
    isTesting,
    testResult, setTestResult,
    pasteInput, setPasteInput,
    showPasteInput, setShowPasteInput,
    isEditMode,

    // SSL/TLS
    showSSL, setShowSSL,
    sslMode, setSSLMode,
    caCert, setCaCert,
    clientCert, setClientCert,
    clientKey, setClientKey,

    // Advanced (Oracle/MSSQL)
    showAdvanced, setShowAdvanced,
    serviceName, setServiceName,
    instanceName, setInstanceName,

    // SSH Tunnel
    showSSH, setShowSSH,
    sshEnabled, setSSHEnabled,
    sshHost, setSSHHost,
    sshPort, setSSHPort,
    sshUsername, setSSHUsername,
    sshAuthMethod, setSSHAuthMethod,
    sshPassword, setSSHPassword,
    sshPrivateKey, setSSHPrivateKey,
    sshPassphrase, setSSHPassphrase,

    // Handlers
    handleTestConnection,
    handleConnect,
    handlePasteConnectionString,

    // Derived data
    dbTypes,
  } = useConnectionForm({ isOpen, onClose, onConnect, editConnection, onTestConnection });

  const formContent = (
    <>
      {/* Progress bar — fixed top */}
      <div className="shrink-0 h-2 w-full bg-blue-600/20">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: '100%' }}
          className="h-full bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.5)]"
        />
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="mb-4 md:mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-xl bg-blue-500/10 border border-blue-500/20">
              <Zap className="w-5 h-5 text-blue-400" />
            </div>
            <h2 className="text-xs md:text-[0.8125rem] font-medium">
              {isEditMode ? 'Edit Connection' : 'New Connection'}
            </h2>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-zinc-500">
              {isEditMode ? 'Update your database connection parameters.' : 'Configure your database connection parameters securely.'}
            </p>
            {!isEditMode && (
              <button
                onClick={() => setShowPasteInput(!showPasteInput)}
                className="flex items-center gap-1.5 text-xs font-mediumr text-blue-400 hover:text-blue-300 transition-colors px-2 py-1 rounded-md hover:bg-blue-500/10"
              >
                <ClipboardPaste className="w-3 h-3" />
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
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="mb-6 overflow-hidden"
            >
              <div className="p-3 rounded-lg border border-blue-500/20 bg-blue-500/5 space-y-2">
                <Label className="text-xs font-mediumr text-blue-400">
                  Paste Connection URL
                </Label>
                <div className="flex gap-2">
                  <Input
                    value={pasteInput}
                    onChange={(e) => setPasteInput(e.target.value)}
                    placeholder="postgres://user:pass@host:5432/db  or  mongodb://..."
                    className="h-9 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 text-xs font-mono flex-1"
                    onKeyDown={(e) => e.key === 'Enter' && handlePasteConnectionString()}
                  />
                  <Button
                    size="sm"
                    onClick={handlePasteConnectionString}
                    className="bg-blue-600 hover:bg-blue-500 text-white h-9 px-4 text-xs font-medium"
                  >
                    Parse
                  </Button>
                </div>
                <p className="text-xs text-zinc-500">
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
              <Database className="w-3 h-3 text-zinc-500" />
              <Label htmlFor="name" className="text-xs font-mediumr text-zinc-500">Connection Name</Label>
            </div>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Database"
              className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-xs"
            />
          </div>

          {/* Environment Selector */}
          <div className="space-y-2">
            <Label className="text-xs font-mediumr text-zinc-500">Environment</Label>
            <div className="flex flex-wrap items-center gap-2">
              {(Object.keys(ENVIRONMENT_COLORS) as ConnectionEnvironment[]).map((env) => (
                <button
                  key={env}
                  onClick={() => setEnvironment(env)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mediumr transition-all border",
                    environment === env
                      ? "border-white/20 bg-white/5 text-zinc-200"
                      : "border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
                  )}
                >
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: ENVIRONMENT_COLORS[env] }}
                  />
                  {env === 'other' ? 'Other' : ENVIRONMENT_LABELS[env]}
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
                    : "bg-zinc-900/50 border-white/5 hover:border-white/10 hover:bg-zinc-900",
                  isEditMode && type !== db.value && "opacity-30 cursor-not-allowed"
                )}
              >
                <db.icon className={cn("w-6 h-6 mb-1 transition-transform group-hover:scale-110", type === db.value ? db.color : "text-zinc-600")} />
                <span className={cn("text-xs font-medium", type === db.value ? "text-zinc-200" : "text-zinc-500")}>
                  {db.label}
                </span>
              </button>
            ))}
          </div>

            <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <>
                {/* Connection string mode toggle */}
                  {getDBConfig(type).showConnectionStringToggle && (
                    <div className="flex items-center gap-2 p-1 rounded-lg bg-zinc-900/50 border border-white/5">
                      <button
                        onClick={() => setMongoConnectionMode('host')}
                        className={cn(
                          "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-medium transition-all",
                          mongoConnectionMode === 'host'
                            ? "bg-blue-600/20 text-blue-400 border border-blue-500/30"
                            : "text-zinc-500 hover:text-zinc-300"
                        )}
                      >
                        <Globe className="w-3 h-3" />
                        Host / Port
                      </button>
                      <button
                        onClick={() => setMongoConnectionMode('connectionString')}
                        className={cn(
                          "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-medium transition-all",
                          mongoConnectionMode === 'connectionString'
                            ? "bg-blue-600/20 text-blue-400 border border-blue-500/30"
                            : "text-zinc-500 hover:text-zinc-300"
                        )}
                      >
                        <Link className="w-3 h-3" />
                        Connection String
                      </button>
                    </div>
                  )}

                  {getDBConfig(type).showConnectionStringToggle && mongoConnectionMode === 'connectionString' ? (
                    <>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 mb-1">
                          <Link className="w-3 h-3 text-zinc-500" />
                          <Label htmlFor="connectionString" className="text-xs font-mediumr text-zinc-500">Connection URI</Label>
                        </div>
                        <Input
                          id="connectionString"
                          value={connectionString}
                          onChange={(e) => setConnectionString(e.target.value)}
                          placeholder="mongodb://localhost:27017/mydb  or  mongodb+srv://..."
                          className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-xs font-mono"
                        />
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 mb-1">
                          <Database className="w-3 h-3 text-zinc-500" />
                          <Label htmlFor="database" className="text-xs font-mediumr text-zinc-500">Database Name (optional override)</Label>
                        </div>
                        <Input
                          id="database"
                          value={database}
                          onChange={(e) => setDatabase(e.target.value)}
                          placeholder="Extracted from URI if not provided"
                          className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-xs font-mono"
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 mb-1">
                          <Globe className="w-3 h-3 text-zinc-500" />
                          <Label htmlFor="host" className="text-xs font-mediumr text-zinc-500">Host & Instance</Label>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                          <Input
                            id="host"
                            value={host}
                            onChange={(e) => setHost(e.target.value)}
                            placeholder="localhost"
                            className="md:col-span-3 h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-xs"
                          />
                          <Input
                            id="port"
                            value={port}
                            onChange={(e) => setPort(e.target.value)}
                            className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-xs font-mono"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <div className="flex items-center gap-2 mb-1">
                            <Key className="w-3 h-3 text-zinc-500" />
                            <Label htmlFor="user" className="text-xs font-mediumr text-zinc-500">Username</Label>
                          </div>
                          <Input
                            id="user"
                            value={user}
                            onChange={(e) => setUser(e.target.value)}
                            placeholder="postgres"
                            className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-xs"
                          />
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center gap-2 mb-1">
                            <ShieldCheck className="w-3 h-3 text-zinc-500" />
                            <Label htmlFor="password" className="text-xs font-mediumr text-zinc-500">Password</Label>
                          </div>
                          <Input
                            id="password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="••••••••"
                            className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-xs"
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center gap-2 mb-1">
                          <Database className="w-3 h-3 text-zinc-500" />
                          <Label htmlFor="database" className="text-xs font-mediumr text-zinc-500">Database Name</Label>
                        </div>
                        <Input
                          id="database"
                          value={database}
                          onChange={(e) => setDatabase(e.target.value)}
                          placeholder="production_db"
                          className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-xs font-mono"
                        />
                      </div>
                    </>
                  )}
              </>
            </div>

          {/* Advanced Settings (Oracle/MSSQL) */}
          {(type === 'oracle' || type === 'mssql') && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-white/5 hover:border-white/10 bg-zinc-900/30 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-all"
              >
                <Settings2 className="w-3.5 h-3.5 text-orange-500" />
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
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="p-3 rounded-lg border border-orange-500/10 bg-orange-500/5 space-y-3">
                      {type === 'oracle' && (
                        <div className="space-y-1.5">
                          <Label className="text-xs font-mediumr text-zinc-500">Service Name</Label>
                          <Input
                            value={serviceName}
                            onChange={(e) => setServiceName(e.target.value)}
                            placeholder="ORCL or XEPDB1"
                            className="h-9 bg-zinc-900/50 border-white/5 focus:border-orange-500/50 text-xs"
                          />
                          <p className="text-xs text-zinc-500">
                            If empty, the Database Name field is used as the service name.
                          </p>
                        </div>
                      )}
                      {type === 'mssql' && (
                        <div className="space-y-1.5">
                          <Label className="text-xs font-mediumr text-zinc-500">Instance Name</Label>
                          <Input
                            value={instanceName}
                            onChange={(e) => setInstanceName(e.target.value)}
                            placeholder="SQLEXPRESS"
                            className="h-9 bg-zinc-900/50 border-white/5 focus:border-orange-500/50 text-xs"
                          />
                          <p className="text-xs text-zinc-500">
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

          {/* SSL/TLS & SSH Panels - only for non-sqlite */}
          {type !== 'sqlite' && (
            <div className="space-y-2">
              {/* SSL/TLS Toggle */}
              <button
                type="button"
                onClick={() => setShowSSL(!showSSL)}
                className="flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-white/5 hover:border-white/10 bg-zinc-900/30 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-all"
              >
                <Lock className="w-3.5 h-3.5 text-emerald-500" />
                <span>SSL / TLS</span>
                {sslMode !== 'disable' && (
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
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="p-3 rounded-lg border border-emerald-500/10 bg-emerald-500/5 space-y-3">
                      <div className="space-y-2">
                        <Label className="text-xs font-mediumr text-zinc-500">SSL Mode</Label>
                        <div className="flex flex-wrap gap-1.5">
                          {(['disable', 'require', 'verify-ca', 'verify-full'] as SSLMode[]).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => setSSLMode(mode)}
                              className={cn(
                                "px-2.5 py-1.5 rounded-md text-xs font-mediumr transition-all border",
                                sslMode === mode
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                                  : "border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
                              )}
                            >
                              {mode}
                            </button>
                          ))}
                        </div>
                      </div>
                      {sslMode !== 'disable' && (
                        <div className="space-y-3">
                          <div className="space-y-1.5">
                            <Label className="text-xs font-mediumr text-zinc-500">CA Certificate (PEM)</Label>
                            <textarea
                              value={caCert}
                              onChange={(e) => setCaCert(e.target.value)}
                              placeholder="-----BEGIN CERTIFICATE-----&#10;Paste CA cert content here...&#10;-----END CERTIFICATE-----"
                              rows={3}
                              className="w-full rounded-md bg-zinc-900/50 border border-white/5 focus:border-emerald-500/50 text-xs font-mono text-zinc-300 p-2 resize-none placeholder:text-zinc-600"
                            />
                          </div>
                          {(sslMode === 'verify-ca' || sslMode === 'verify-full') && (
                            <>
                              <div className="space-y-1.5">
                                <Label className="text-xs font-mediumr text-zinc-500">Client Certificate (PEM)</Label>
                                <textarea
                                  value={clientCert}
                                  onChange={(e) => setClientCert(e.target.value)}
                                  placeholder="-----BEGIN CERTIFICATE-----&#10;Optional client cert...&#10;-----END CERTIFICATE-----"
                                  rows={3}
                                  className="w-full rounded-md bg-zinc-900/50 border border-white/5 focus:border-emerald-500/50 text-xs font-mono text-zinc-300 p-2 resize-none placeholder:text-zinc-600"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs font-mediumr text-zinc-500">Client Private Key (PEM)</Label>
                                <textarea
                                  value={clientKey}
                                  onChange={(e) => setClientKey(e.target.value)}
                                  placeholder="-----BEGIN PRIVATE KEY-----&#10;Optional client key...&#10;-----END PRIVATE KEY-----"
                                  rows={3}
                                  className="w-full rounded-md bg-zinc-900/50 border border-white/5 focus:border-emerald-500/50 text-xs font-mono text-zinc-300 p-2 resize-none placeholder:text-zinc-600"
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
                className="flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-white/5 hover:border-white/10 bg-zinc-900/30 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-all"
              >
                <Terminal className="w-3.5 h-3.5 text-purple-500" />
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
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="p-3 rounded-lg border border-purple-500/10 bg-purple-500/5 space-y-3">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={sshEnabled}
                          onChange={(e) => setSSHEnabled(e.target.checked)}
                          className="rounded border-white/20 bg-zinc-900/50"
                        />
                        <span className="text-xs font-medium text-zinc-300">Enable SSH Tunnel</span>
                      </label>
                      {sshEnabled && (
                        <div className="space-y-3">
                          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                            <div className="md:col-span-3 space-y-1.5">
                              <Label className="text-xs font-mediumr text-zinc-500">SSH Host</Label>
                              <Input
                                value={sshHost}
                                onChange={(e) => setSSHHost(e.target.value)}
                                placeholder="bastion.example.com"
                                className="h-9 bg-zinc-900/50 border-white/5 focus:border-purple-500/50 text-xs"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs font-mediumr text-zinc-500">Port</Label>
                              <Input
                                value={sshPort}
                                onChange={(e) => setSSHPort(e.target.value)}
                                className="h-9 bg-zinc-900/50 border-white/5 focus:border-purple-500/50 text-xs font-mono"
                              />
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs font-mediumr text-zinc-500">Username</Label>
                            <Input
                              value={sshUsername}
                              onChange={(e) => setSSHUsername(e.target.value)}
                              placeholder="ubuntu"
                              className="h-9 bg-zinc-900/50 border-white/5 focus:border-purple-500/50 text-xs"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-mediumr text-zinc-500">Auth Method</Label>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => setSSHAuthMethod('password')}
                                className={cn(
                                  "flex-1 px-3 py-1.5 rounded-md text-xs font-mediumr transition-all border",
                                  sshAuthMethod === 'password'
                                    ? "border-purple-500/30 bg-purple-500/10 text-purple-400"
                                    : "border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
                                )}
                              >
                                Password
                              </button>
                              <button
                                type="button"
                                onClick={() => setSSHAuthMethod('privateKey')}
                                className={cn(
                                  "flex-1 px-3 py-1.5 rounded-md text-xs font-mediumr transition-all border",
                                  sshAuthMethod === 'privateKey'
                                    ? "border-purple-500/30 bg-purple-500/10 text-purple-400"
                                    : "border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
                                )}
                              >
                                Private Key
                              </button>
                            </div>
                          </div>
                          {sshAuthMethod === 'password' ? (
                            <div className="space-y-1.5">
                              <Label className="text-xs font-mediumr text-zinc-500">SSH Password</Label>
                              <Input
                                type="password"
                                value={sshPassword}
                                onChange={(e) => setSSHPassword(e.target.value)}
                                placeholder="••••••••"
                                className="h-9 bg-zinc-900/50 border-white/5 focus:border-purple-500/50 text-xs"
                              />
                            </div>
                          ) : (
                            <div className="space-y-3">
                              <div className="space-y-1.5">
                                <Label className="text-xs font-mediumr text-zinc-500">Private Key (PEM)</Label>
                                <textarea
                                  value={sshPrivateKey}
                                  onChange={(e) => setSSHPrivateKey(e.target.value)}
                                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;Paste private key here...&#10;-----END OPENSSH PRIVATE KEY-----"
                                  rows={4}
                                  className="w-full rounded-md bg-zinc-900/50 border border-white/5 focus:border-purple-500/50 text-xs font-mono text-zinc-300 p-2 resize-none placeholder:text-zinc-600"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs font-mediumr text-zinc-500">Passphrase (optional)</Label>
                                <Input
                                  type="password"
                                  value={sshPassphrase}
                                  onChange={(e) => setSSHPassphrase(e.target.value)}
                                  placeholder="Key passphrase (if encrypted)"
                                  className="h-9 bg-zinc-900/50 border-white/5 focus:border-purple-500/50 text-xs"
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
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className={cn(
                  "flex items-center gap-2 p-3 rounded-lg border text-xs",
                  testResult.success
                    ? "bg-emerald-500/5 border-emerald-500/20 text-emerald-400"
                    : "bg-red-500/5 border-red-500/20 text-red-400"
                )}>
                  {testResult.success ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 shrink-0" />
                  )}
                  <span className="leading-relaxed">{testResult.message}</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Sticky footer */}
      <div className="shrink-0 bg-zinc-900/30 p-4 md:p-6 border-t border-white/5">
        <div className="flex flex-col-reverse gap-3 md:flex-row md:items-center md:justify-between">
          <Button
            variant="ghost"
            onClick={onClose}
            className="w-full md:w-auto text-zinc-500 hover:text-zinc-200 hover:bg-white/5 text-xs font-medium"
          >
            Cancel
          </Button>
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-2">
            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={isTesting}
              className="w-full md:w-auto border-white/10 text-zinc-400 hover:text-white hover:bg-white/5 text-xs font-medium h-10 px-4"
            >
              {isTesting ? (
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 border-2 border-zinc-400/30 border-t-zinc-400 rounded-full animate-spin" />
                  Testing...
                </div>
              ) : (
                'Test Connection'
              )}
            </Button>
            <Button
              onClick={handleConnect}
              disabled={isTesting || (getDBConfig(type).showConnectionStringToggle && mongoConnectionMode === 'connectionString' && !connectionString.trim())}
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
                    {isEditMode ? 'Save Changes' : 'Establish Connection'}
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
      <Drawer open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
        <DrawerContent className="max-h-[95dvh] bg-[#0a0a0a] border-white/5 text-zinc-200 p-0 flex flex-col">
          <DrawerHeader className="sr-only">
            <DrawerTitle>{isEditMode ? 'Edit Connection' : 'New Connection'}</DrawerTitle>
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
        className="sm:max-w-[500px] lg:max-w-[540px] max-h-[90vh] bg-[#0a0a0a] border-white/5 text-zinc-200 p-0 overflow-hidden shadow-2xl flex flex-col"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{isEditMode ? 'Edit Connection' : 'New Connection'}</DialogTitle>
        <DialogDescription className="sr-only">Configure database connection parameters.</DialogDescription>
        {formContent}
      </DialogContent>
    </Dialog>
  );
}
