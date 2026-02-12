"use client";

import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DatabaseConnection, DatabaseType, ConnectionEnvironment, ENVIRONMENT_COLORS, ENVIRONMENT_LABELS } from '@/lib/types';
import { Database, ShieldCheck, Zap, Globe, Key, Link, CheckCircle2, XCircle, ClipboardPaste } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getDBConfig } from '@/lib/db-ui-config';
import { parseConnectionString } from '@/lib/connection-string-parser';
import { motion, AnimatePresence } from 'framer-motion';

interface ConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (conn: DatabaseConnection) => void;
  editConnection?: DatabaseConnection | null;
}

export function ConnectionModal({ isOpen, onClose, onConnect, editConnection }: ConnectionModalProps) {
  const [type, setType] = useState<DatabaseType>('postgres');
  const [name, setName] = useState('');
  const [host, setHost] = useState('localhost');
  const [port, setPort] = useState('5432');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [database, setDatabase] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [connectionString, setConnectionString] = useState('');
  const [mongoConnectionMode, setMongoConnectionMode] = useState<'host' | 'connectionString'>('host');
  const [environment, setEnvironment] = useState<ConnectionEnvironment>('local');
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; latency?: number } | null>(null);
  const [pasteInput, setPasteInput] = useState('');
  const [showPasteInput, setShowPasteInput] = useState(false);

  const isEditMode = !!editConnection;

  // Populate form when editing
  useEffect(() => {
    if (editConnection) {
      setType(editConnection.type);
      setName(editConnection.name);
      setHost(editConnection.host || 'localhost');
      setPort(editConnection.port?.toString() || getDBConfig(editConnection.type).defaultPort);
      setUser(editConnection.user || '');
      setPassword(editConnection.password || '');
      setDatabase(editConnection.database || '');
      setConnectionString(editConnection.connectionString || '');
      setEnvironment(editConnection.environment || 'local');
      if (editConnection.connectionString) {
        setMongoConnectionMode('connectionString');
      }
    }
  }, [editConnection]);

  // Reset form when modal closes
  useEffect(() => {
    if (!isOpen) {
      setTestResult(null);
      setShowPasteInput(false);
      setPasteInput('');
      if (!editConnection) {
        setName('');
        setUser('');
        setPassword('');
        setDatabase('');
        setConnectionString('');
        setMongoConnectionMode('host');
        setType('postgres');
        setHost('localhost');
        setPort('5432');
      }
    }
  }, [isOpen, editConnection]);

  const buildConnection = (): DatabaseConnection => {
    return {
      id: editConnection?.id || Math.random().toString(36).substr(2, 9),
      name: name || `${type}-connection`,
      type,
      host,
      port: parseInt(port),
      user,
      password,
      database,
      createdAt: editConnection?.createdAt || new Date(),
      environment,
      color: ENVIRONMENT_COLORS[environment],
      ...(getDBConfig(type).showConnectionStringToggle && mongoConnectionMode === 'connectionString' ? {
        connectionString,
        host: undefined,
        port: undefined,
        user: undefined,
        password: undefined,
      } : {}),
    };
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);

    try {
      const conn = buildConnection();
      const response = await fetch('/api/db/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conn),
      });

      const result = await response.json();
      setTestResult({
        success: result.success,
        message: result.success
          ? `Connected successfully${result.latency ? ` (${result.latency}ms)` : ''}`
          : result.error || 'Connection failed',
        latency: result.latency,
      });
    } catch {
      setTestResult({ success: false, message: 'Network error - could not reach server' });
    } finally {
      setIsTesting(false);
    }
  };

  const handleConnect = async () => {
    setIsTesting(true);
    setTestResult(null);

    try {
      const conn = buildConnection();

      // Skip real test for demo connections
      if (type === 'demo') {
        onConnect(conn);
        setIsTesting(false);
        return;
      }

      // Real connection test before saving
      const response = await fetch('/api/db/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conn),
      });

      const result = await response.json();

      if (result.success) {
        onConnect(conn);
        // Reset form
        setName('');
        setUser('');
        setPassword('');
        setDatabase('');
        setConnectionString('');
        setMongoConnectionMode('host');
        setTestResult(null);
      } else {
        setTestResult({ success: false, message: result.error || 'Connection failed' });
      }
    } catch {
      setTestResult({ success: false, message: 'Network error - could not reach server' });
    } finally {
      setIsTesting(false);
    }
  };

  const handlePasteConnectionString = () => {
    const trimmed = pasteInput.trim();
    if (!trimmed) return;

    const parsed = parseConnectionString(trimmed);
    if (!parsed) {
      setTestResult({ success: false, message: 'Could not parse connection string. Supported formats: postgres://, mysql://, mongodb://, redis://' });
      return;
    }

    // Auto-switch DB type
    setType(parsed.type);
    if (parsed.host) setHost(parsed.host);
    if (parsed.port) setPort(parsed.port);
    if (parsed.user) setUser(parsed.user);
    if (parsed.password) setPassword(parsed.password);
    if (parsed.database) setDatabase(parsed.database);

    // For MongoDB, also set connection string mode
    if (parsed.type === 'mongodb' && parsed.connectionString) {
      setConnectionString(parsed.connectionString);
      setMongoConnectionMode('connectionString');
    }

    // Auto-fill name if empty
    if (!name) {
      const dbName = parsed.database || parsed.host || parsed.type;
      setName(`${dbName}`);
    }

    setShowPasteInput(false);
    setPasteInput('');
    setTestResult({ success: true, message: 'Connection string parsed successfully. Review the fields and connect.' });
  };

  const selectableTypes: DatabaseType[] = ['postgres', 'mysql', 'mongodb', 'redis', 'demo'];
  const dbTypes = selectableTypes.map(t => {
    const cfg = getDBConfig(t);
    return { value: t, label: cfg.label, icon: cfg.icon, color: cfg.color };
  });

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px] bg-[#0a0a0a] border-white/5 text-zinc-200 p-0 overflow-hidden shadow-2xl">
        <div className="h-2 w-full bg-blue-600/20">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: '100%' }}
            className="h-full bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.5)]"
          />
        </div>

        <div className="p-8">
          <DialogHeader className="mb-8">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-xl bg-blue-500/10 border border-blue-500/20">
                <Zap className="w-5 h-5 text-blue-400" />
              </div>
              <DialogTitle className="text-2xl font-bold tracking-tight">
                {isEditMode ? 'Edit Connection' : 'New Connection'}
              </DialogTitle>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-sm text-zinc-500">
                {isEditMode ? 'Update your database connection parameters.' : 'Configure your database connection parameters securely.'}
              </p>
              {!isEditMode && (
                <button
                  onClick={() => setShowPasteInput(!showPasteInput)}
                  className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-blue-400 hover:text-blue-300 transition-colors px-2 py-1 rounded-md hover:bg-blue-500/10"
                >
                  <ClipboardPaste className="w-3 h-3" />
                  Paste URL
                </button>
              )}
            </div>
          </DialogHeader>

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
                  <Label className="text-[10px] font-bold uppercase tracking-wider text-blue-400">
                    Paste Connection URL
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      value={pasteInput}
                      onChange={(e) => setPasteInput(e.target.value)}
                      placeholder="postgres://user:pass@host:5432/db  or  mongodb://..."
                      className="h-9 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 text-sm font-mono flex-1"
                      onKeyDown={(e) => e.key === 'Enter' && handlePasteConnectionString()}
                    />
                    <Button
                      size="sm"
                      onClick={handlePasteConnectionString}
                      className="bg-blue-600 hover:bg-blue-500 text-white h-9 px-4 text-xs font-bold"
                    >
                      Parse
                    </Button>
                  </div>
                  <p className="text-[10px] text-zinc-500">
                    Supports: postgres://, mysql://, mongodb://, redis://
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="space-y-6">
            {/* Connection Name - always visible */}
            {type !== 'demo' && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 mb-1">
                  <Database className="w-3 h-3 text-zinc-500" />
                  <Label htmlFor="name" className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Connection Name</Label>
                </div>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Database"
                  className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-sm"
                />
              </div>
            )}

            {/* Environment Selector */}
            {type !== 'demo' && (
              <div className="space-y-2">
                <Label className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Environment</Label>
                <div className="flex items-center gap-2">
                  {(Object.keys(ENVIRONMENT_COLORS) as ConnectionEnvironment[]).map((env) => (
                    <button
                      key={env}
                      onClick={() => setEnvironment(env)}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all border",
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
            )}

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
                    "flex flex-col items-center justify-center p-4 rounded-xl border transition-all duration-200 gap-2 group",
                    type === db.value
                      ? "bg-blue-600/10 border-blue-500/50 shadow-[0_0_20px_rgba(59,130,246,0.1)]"
                      : "bg-zinc-900/50 border-white/5 hover:border-white/10 hover:bg-zinc-900",
                    isEditMode && type !== db.value && "opacity-30 cursor-not-allowed"
                  )}
                >
                  <db.icon className={cn("w-6 h-6 mb-1 transition-transform group-hover:scale-110", type === db.value ? db.color : "text-zinc-600")} />
                  <span className={cn("text-xs font-semibold", type === db.value ? "text-zinc-200" : "text-zinc-500")}>
                    {db.label}
                  </span>
                </button>
              ))}
            </div>

              <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                {type !== 'demo' ? (
                  <>
                    {/* Connection string mode toggle */}
                    {getDBConfig(type).showConnectionStringToggle && (
                      <div className="flex items-center gap-2 p-1 rounded-lg bg-zinc-900/50 border border-white/5">
                        <button
                          onClick={() => setMongoConnectionMode('host')}
                          className={cn(
                            "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-bold transition-all",
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
                            "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-bold transition-all",
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
                            <Label htmlFor="connectionString" className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Connection URI</Label>
                          </div>
                          <Input
                            id="connectionString"
                            value={connectionString}
                            onChange={(e) => setConnectionString(e.target.value)}
                            placeholder="mongodb://localhost:27017/mydb  or  mongodb+srv://..."
                            className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-sm font-mono"
                          />
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center gap-2 mb-1">
                            <Database className="w-3 h-3 text-zinc-500" />
                            <Label htmlFor="database" className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Database Name (optional override)</Label>
                          </div>
                          <Input
                            id="database"
                            value={database}
                            onChange={(e) => setDatabase(e.target.value)}
                            placeholder="Extracted from URI if not provided"
                            className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-sm font-mono"
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="space-y-2">
                          <div className="flex items-center gap-2 mb-1">
                            <Globe className="w-3 h-3 text-zinc-500" />
                            <Label htmlFor="host" className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Host & Instance</Label>
                          </div>
                          <div className="grid grid-cols-4 gap-3">
                            <Input
                              id="host"
                              value={host}
                              onChange={(e) => setHost(e.target.value)}
                              placeholder="localhost"
                              className="col-span-3 h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-sm"
                            />
                            <Input
                              id="port"
                              value={port}
                              onChange={(e) => setPort(e.target.value)}
                              className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-sm font-mono"
                            />
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 mb-1">
                              <Key className="w-3 h-3 text-zinc-500" />
                              <Label htmlFor="user" className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Username</Label>
                            </div>
                            <Input
                              id="user"
                              value={user}
                              onChange={(e) => setUser(e.target.value)}
                              placeholder="postgres"
                              className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-sm"
                            />
                          </div>
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 mb-1">
                              <ShieldCheck className="w-3 h-3 text-zinc-500" />
                              <Label htmlFor="password" className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Password</Label>
                            </div>
                            <Input
                              id="password"
                              type="password"
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              placeholder="••••••••"
                              className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-sm"
                            />
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div className="flex items-center gap-2 mb-1">
                            <Database className="w-3 h-3 text-zinc-500" />
                            <Label htmlFor="database" className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Database Name</Label>
                          </div>
                          <Input
                            id="database"
                            value={database}
                            onChange={(e) => setDatabase(e.target.value)}
                            placeholder="production_db"
                            className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-sm font-mono"
                          />
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <div className="p-8 border border-white/5 rounded-xl bg-zinc-900/30 text-center space-y-3">
                    <Zap className="w-8 h-8 text-yellow-500 mx-auto opacity-50" />
                    <div className="space-y-1">
                      <h4 className="text-sm font-semibold text-zinc-300">Demo Connection Mode</h4>
                      <p className="text-xs text-zinc-500 leading-relaxed">
                        No real database required. This mode will load a pre-populated schema with mock data for testing the interface.
                      </p>
                    </div>
                    <div className="pt-2">
                       <Label htmlFor="name" className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-2 block text-left">Connection Name</Label>
                       <Input
                        id="name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="My Demo DB"
                        className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-sm"
                      />
                    </div>
                  </div>
                )}
              </div>

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

        <DialogFooter className="bg-zinc-900/30 p-6 flex items-center justify-between sm:justify-between border-t border-white/5 gap-3">
          <Button
            variant="ghost"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 hover:bg-white/5 text-xs font-semibold"
          >
            Cancel
          </Button>
          <div className="flex items-center gap-2">
            {type !== 'demo' && (
              <Button
                variant="outline"
                onClick={handleTestConnection}
                disabled={isTesting}
                className="border-white/10 text-zinc-400 hover:text-white hover:bg-white/5 text-xs font-bold h-10 px-4"
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
            )}
            <Button
              onClick={handleConnect}
              disabled={isTesting || (getDBConfig(type).showConnectionStringToggle && mongoConnectionMode === 'connectionString' && !connectionString.trim())}
              className="bg-blue-600 hover:bg-blue-500 text-white min-w-[140px] font-bold text-xs h-10 shadow-lg shadow-blue-900/20 group relative overflow-hidden"
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
