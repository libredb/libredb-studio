'use client';

import { useState, useEffect, useCallback } from 'react';
import { DatabaseConnection, DatabaseType, ConnectionEnvironment, ENVIRONMENT_COLORS, SSLMode, SSLConfig, SSHTunnelConfig } from '@/lib/types';
import { getDBConfig } from '@/lib/db-ui-config';
import { parseConnectionString } from '@/lib/connection-string-parser';

interface UseConnectionFormProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (conn: DatabaseConnection) => void;
  editConnection?: DatabaseConnection | null;
  /** Optional API adapter: when provided, bypasses the built-in /api/db/test-connection fetch. */
  onTestConnection?: (connection: DatabaseConnection) => Promise<{ success: boolean; latency?: number; error?: string }>;
}

export function useConnectionForm({ isOpen, onConnect, editConnection, onTestConnection }: UseConnectionFormProps) {
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

  // SSL/TLS
  const [showSSL, setShowSSL] = useState(false);
  const [sslMode, setSSLMode] = useState<SSLMode>('disable');
  const [caCert, setCaCert] = useState('');
  const [clientCert, setClientCert] = useState('');
  const [clientKey, setClientKey] = useState('');

  // Advanced (Oracle/MSSQL)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [serviceName, setServiceName] = useState('');
  const [instanceName, setInstanceName] = useState('');

  // SSH Tunnel
  const [showSSH, setShowSSH] = useState(false);
  const [sshEnabled, setSSHEnabled] = useState(false);
  const [sshHost, setSSHHost] = useState('');
  const [sshPort, setSSHPort] = useState('22');
  const [sshUsername, setSSHUsername] = useState('');
  const [sshAuthMethod, setSSHAuthMethod] = useState<'password' | 'privateKey'>('password');
  const [sshPassword, setSSHPassword] = useState('');
  const [sshPrivateKey, setSSHPrivateKey] = useState('');
  const [sshPassphrase, setSSHPassphrase] = useState('');

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
      // Advanced fields
      if (editConnection.serviceName) {
        setServiceName(editConnection.serviceName);
        setShowAdvanced(true);
      }
      if (editConnection.instanceName) {
        setInstanceName(editConnection.instanceName);
        setShowAdvanced(true);
      }
      // SSL
      if (editConnection.ssl) {
        setSSLMode(editConnection.ssl.mode);
        setCaCert(editConnection.ssl.caCert || '');
        setClientCert(editConnection.ssl.clientCert || '');
        setClientKey(editConnection.ssl.clientKey || '');
        if (editConnection.ssl.mode !== 'disable') setShowSSL(true);
      }
      // SSH
      if (editConnection.sshTunnel?.enabled) {
        setSSHEnabled(true);
        setShowSSH(true);
        setSSHHost(editConnection.sshTunnel.host);
        setSSHPort(editConnection.sshTunnel.port.toString());
        setSSHUsername(editConnection.sshTunnel.username);
        setSSHAuthMethod(editConnection.sshTunnel.authMethod);
        setSSHPassword(editConnection.sshTunnel.password || '');
        setSSHPrivateKey(editConnection.sshTunnel.privateKey || '');
        setSSHPassphrase(editConnection.sshTunnel.passphrase || '');
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

  const buildConnection = useCallback((): DatabaseConnection => {
    const sslConfig: SSLConfig | undefined = sslMode !== 'disable' ? {
      mode: sslMode,
      ...(caCert ? { caCert } : {}),
      ...(clientCert ? { clientCert } : {}),
      ...(clientKey ? { clientKey } : {}),
    } : undefined;

    const sshConfig: SSHTunnelConfig | undefined = sshEnabled ? {
      enabled: true,
      host: sshHost,
      port: parseInt(sshPort) || 22,
      username: sshUsername,
      authMethod: sshAuthMethod,
      ...(sshAuthMethod === 'password' ? { password: sshPassword } : {}),
      ...(sshAuthMethod === 'privateKey' ? { privateKey: sshPrivateKey } : {}),
      ...(sshPassphrase ? { passphrase: sshPassphrase } : {}),
    } : undefined;

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
      ...(sslConfig ? { ssl: sslConfig } : {}),
      ...(sshConfig ? { sshTunnel: sshConfig } : {}),
      ...(getDBConfig(type).showConnectionStringToggle && mongoConnectionMode === 'connectionString' ? {
        connectionString,
        host: undefined,
        port: undefined,
        user: undefined,
        password: undefined,
      } : {}),
      ...(type === 'oracle' && serviceName ? { serviceName } : {}),
      ...(type === 'mssql' && instanceName ? { instanceName } : {}),
    };
  }, [
    sslMode, caCert, clientCert, clientKey,
    sshEnabled, sshHost, sshPort, sshUsername, sshAuthMethod, sshPassword, sshPrivateKey, sshPassphrase,
    editConnection, name, type, host, port, user, password, database, environment,
    mongoConnectionMode, connectionString, serviceName, instanceName,
  ]);

  const handleTestConnection = useCallback(async () => {
    setIsTesting(true);
    setTestResult(null);

    try {
      const conn = buildConnection();

      if (onTestConnection) {
        // Platform adapter: use callback instead of fetch
        const result = await onTestConnection(conn);
        setTestResult({
          success: result.success,
          message: result.success
            ? `Connected successfully${result.latency ? ` (${result.latency}ms)` : ''}`
            : result.error || 'Connection failed',
          latency: result.latency,
        });
      } else {
        // Default: existing fetch behavior
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
      }
    } catch {
      setTestResult({ success: false, message: 'Network error - could not reach server' });
    } finally {
      setIsTesting(false);
    }
  }, [buildConnection, onTestConnection]);

  const handleConnect = useCallback(async () => {
    setIsTesting(true);
    setTestResult(null);

    try {
      const conn = buildConnection();

      let result: { success: boolean; error?: string };
      if (onTestConnection) {
        // Platform adapter: use callback instead of fetch
        result = await onTestConnection(conn);
      } else {
        // Default: existing fetch behavior
        const response = await fetch('/api/db/test-connection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(conn),
        });
        result = await response.json();
      }

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
  }, [buildConnection, type, onConnect, onTestConnection]);

  const handlePasteConnectionString = useCallback(() => {
    const trimmed = pasteInput.trim();
    if (!trimmed) return;

    const parsed = parseConnectionString(trimmed);
    if (!parsed) {
      setTestResult({ success: false, message: 'Could not parse connection string. Supported formats: postgres://, mysql://, mongodb://, redis://, oracle://, mssql://' });
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
  }, [pasteInput, name]);

  const selectableTypes: DatabaseType[] = ['postgres', 'mysql', 'oracle', 'mssql', 'mongodb', 'redis'];
  const dbTypes = selectableTypes.map(t => {
    const cfg = getDBConfig(t);
    return { value: t, label: cfg.label, icon: cfg.icon, color: cfg.color };
  });

  return {
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
  };
}
