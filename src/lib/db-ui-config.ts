import { type LucideIcon } from 'lucide-react';
import { PostgreSQLIcon, MySQLIcon, SQLiteIcon, MongoDBIcon, RedisIcon, OracleIcon, MSSQLIcon } from '@/components/icons/db-icons';
import type { DatabaseType } from '@/lib/types';

// DB brand icons share the same interface as LucideIcon (className + SVG props)
type DBIcon = LucideIcon | React.FC<React.SVGAttributes<SVGSVGElement> & { className?: string }>;

export interface DatabaseUIConfig {
  icon: DBIcon;
  color: string;
  label: string;
  defaultPort: string;
  showConnectionStringToggle: boolean;
  connectionFields: ('host' | 'port' | 'user' | 'password' | 'database' | 'connectionString' | 'serviceName' | 'instanceName')[];
}

const DB_UI_CONFIG: Record<DatabaseType, DatabaseUIConfig> = {
  postgres: {
    icon: PostgreSQLIcon,
    color: 'text-blue-400',
    label: 'PostgreSQL',
    defaultPort: '5432',
    showConnectionStringToggle: false,
    connectionFields: ['host', 'port', 'user', 'password', 'database'],
  },
  mysql: {
    icon: MySQLIcon,
    color: 'text-amber-400',
    label: 'MySQL',
    defaultPort: '3306',
    showConnectionStringToggle: false,
    connectionFields: ['host', 'port', 'user', 'password', 'database'],
  },
  sqlite: {
    icon: SQLiteIcon,
    color: 'text-cyan-400',
    label: 'SQLite',
    defaultPort: '',
    showConnectionStringToggle: false,
    connectionFields: ['database'],
  },
  mongodb: {
    icon: MongoDBIcon,
    color: 'text-emerald-400',
    label: 'MongoDB',
    defaultPort: '27017',
    showConnectionStringToggle: true,
    connectionFields: ['host', 'port', 'user', 'password', 'database', 'connectionString'],
  },
  redis: {
    icon: RedisIcon,
    color: 'text-rose-400',
    label: 'Redis',
    defaultPort: '6379',
    showConnectionStringToggle: false,
    connectionFields: ['host', 'port', 'password', 'database'],
  },
  oracle: {
    icon: OracleIcon,
    color: 'text-red-400',
    label: 'Oracle',
    defaultPort: '1521',
    showConnectionStringToggle: false,
    connectionFields: ['host', 'port', 'user', 'password', 'database', 'serviceName'],
  },
  mssql: {
    icon: MSSQLIcon,
    color: 'text-sky-400',
    label: 'SQL Server',
    defaultPort: '1433',
    showConnectionStringToggle: false,
    connectionFields: ['host', 'port', 'user', 'password', 'database', 'instanceName'],
  },
};

export function getDBConfig(type: DatabaseType): DatabaseUIConfig {
  return DB_UI_CONFIG[type];
}

export function getDBIcon(type: DatabaseType): DBIcon {
  return DB_UI_CONFIG[type].icon;
}

export function getDBColor(type: DatabaseType): string {
  return DB_UI_CONFIG[type].color;
}
