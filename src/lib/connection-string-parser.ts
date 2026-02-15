import { DatabaseType } from '@/lib/types';

export interface ParsedConnection {
  type: DatabaseType;
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  database?: string;
  connectionString?: string;
}

/**
 * Parse a database connection string URL into its components.
 * Supports: postgres://, postgresql://, mysql://, mongodb://, mongodb+srv://, redis://
 */
export function parseConnectionString(input: string): ParsedConnection | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // MongoDB connection strings
  if (trimmed.startsWith('mongodb://') || trimmed.startsWith('mongodb+srv://')) {
    return parseMongoDBString(trimmed);
  }

  // PostgreSQL
  if (trimmed.startsWith('postgres://') || trimmed.startsWith('postgresql://')) {
    return parseGenericURL(trimmed, 'postgres', '5432');
  }

  // MySQL
  if (trimmed.startsWith('mysql://')) {
    return parseGenericURL(trimmed, 'mysql', '3306');
  }

  // Redis
  if (trimmed.startsWith('redis://') || trimmed.startsWith('rediss://')) {
    return parseGenericURL(trimmed, 'redis', '6379');
  }

  // Oracle
  if (trimmed.startsWith('oracle://')) {
    return parseGenericURL(trimmed, 'oracle', '1521');
  }

  // MSSQL / SQL Server
  if (trimmed.startsWith('mssql://') || trimmed.startsWith('sqlserver://')) {
    return parseGenericURL(trimmed, 'mssql', '1433');
  }

  // ADO.NET format: Server=host;Database=db;User Id=user;Password=pass;
  if (/^Server\s*=/i.test(trimmed)) {
    return parseADONetString(trimmed);
  }

  return null;
}

function parseMongoDBString(uri: string): ParsedConnection {
  const result: ParsedConnection = {
    type: 'mongodb',
    connectionString: uri,
  };

  try {
    // For mongodb+srv, we can't use URL directly for host/port
    // but we can extract user/pass/database
    const isSRV = uri.startsWith('mongodb+srv://');

    // Extract database from path
    const withoutProtocol = uri.replace(/^mongodb(\+srv)?:\/\//, '');
    const atIndex = withoutProtocol.indexOf('@');
    const afterAuth = atIndex >= 0 ? withoutProtocol.slice(atIndex + 1) : withoutProtocol;

    // Split host(s) from path
    const slashIndex = afterAuth.indexOf('/');
    if (slashIndex >= 0) {
      const pathPart = afterAuth.slice(slashIndex + 1);
      const dbName = pathPart.split('?')[0];
      if (dbName) result.database = decodeURIComponent(dbName);
    }

    // Extract credentials
    if (atIndex >= 0) {
      const authPart = withoutProtocol.slice(0, atIndex);
      const colonIndex = authPart.indexOf(':');
      if (colonIndex >= 0) {
        result.user = decodeURIComponent(authPart.slice(0, colonIndex));
        result.password = decodeURIComponent(authPart.slice(colonIndex + 1));
      } else {
        result.user = decodeURIComponent(authPart);
      }
    }

    // Extract host/port for non-SRV
    if (!isSRV && slashIndex >= 0) {
      const hostPart = afterAuth.slice(0, slashIndex);
      const firstHost = hostPart.split(',')[0]; // take first host for replica sets
      const [host, port] = firstHost.split(':');
      if (host) result.host = host;
      if (port) result.port = port;
    }
  } catch {
    // If parsing fails, we still have the connectionString
  }

  return result;
}

function parseADONetString(input: string): ParsedConnection | null {
  try {
    const params: Record<string, string> = {};
    input.split(';').forEach((part) => {
      const eq = part.indexOf('=');
      if (eq > 0) {
        const key = part.slice(0, eq).trim().toLowerCase();
        const val = part.slice(eq + 1).trim();
        params[key] = val;
      }
    });

    const host = params['server'] || params['data source'] || 'localhost';
    const [hostPart, portPart] = host.split(',');

    return {
      type: 'mssql',
      host: hostPart || 'localhost',
      port: portPart || '1433',
      user: params['user id'] || params['uid'] || undefined,
      password: params['password'] || params['pwd'] || undefined,
      database: params['database'] || params['initial catalog'] || undefined,
    };
  } catch {
    return null;
  }
}

function parseGenericURL(
  uri: string,
  type: DatabaseType,
  defaultPort: string
): ParsedConnection | null {
  try {
    const url = new URL(uri);

    return {
      type,
      host: url.hostname || 'localhost',
      port: url.port || defaultPort,
      user: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      database: url.pathname.slice(1) || undefined, // remove leading /
    };
  } catch {
    return null;
  }
}

/**
 * Detect the database type from a connection string.
 */
export function detectConnectionStringType(input: string): DatabaseType | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.startsWith('postgres://') || trimmed.startsWith('postgresql://')) return 'postgres';
  if (trimmed.startsWith('mysql://')) return 'mysql';
  if (trimmed.startsWith('mongodb://') || trimmed.startsWith('mongodb+srv://')) return 'mongodb';
  if (trimmed.startsWith('redis://') || trimmed.startsWith('rediss://')) return 'redis';
  if (trimmed.startsWith('oracle://')) return 'oracle';
  if (trimmed.startsWith('mssql://') || trimmed.startsWith('sqlserver://')) return 'mssql';
  if (/^server\s*=/i.test(trimmed)) return 'mssql';
  return null;
}
