import { Cloud, HardDrive, Database, Cpu, Layers, Zap, type LucideIcon } from 'lucide-react';
import type { DatabaseType } from '@/lib/types';

export interface DatabaseUIConfig {
  icon: LucideIcon;
  color: string;
  label: string;
  defaultPort: string;
  showConnectionStringToggle: boolean;
  connectionFields: ('host' | 'port' | 'user' | 'password' | 'database' | 'connectionString')[];
}

const DB_UI_CONFIG: Record<DatabaseType, DatabaseUIConfig> = {
  postgres: {
    icon: Cloud,
    color: 'text-blue-400',
    label: 'PostgreSQL',
    defaultPort: '5432',
    showConnectionStringToggle: false,
    connectionFields: ['host', 'port', 'user', 'password', 'database'],
  },
  mysql: {
    icon: HardDrive,
    color: 'text-amber-400',
    label: 'MySQL',
    defaultPort: '3306',
    showConnectionStringToggle: false,
    connectionFields: ['host', 'port', 'user', 'password', 'database'],
  },
  sqlite: {
    icon: Database,
    color: 'text-cyan-400',
    label: 'SQLite',
    defaultPort: '',
    showConnectionStringToggle: false,
    connectionFields: ['database'],
  },
  mongodb: {
    icon: Layers,
    color: 'text-emerald-400',
    label: 'MongoDB',
    defaultPort: '27017',
    showConnectionStringToggle: true,
    connectionFields: ['host', 'port', 'user', 'password', 'database', 'connectionString'],
  },
  redis: {
    icon: Cpu,
    color: 'text-rose-400',
    label: 'Redis',
    defaultPort: '6379',
    showConnectionStringToggle: false,
    connectionFields: ['host', 'port', 'password', 'database'],
  },
  demo: {
    icon: Zap,
    color: 'text-yellow-400',
    label: 'Demo Data',
    defaultPort: '',
    showConnectionStringToggle: false,
    connectionFields: [],
  },
};

export function getDBConfig(type: DatabaseType): DatabaseUIConfig {
  return DB_UI_CONFIG[type];
}

export function getDBIcon(type: DatabaseType): LucideIcon {
  return DB_UI_CONFIG[type].icon;
}

export function getDBColor(type: DatabaseType): string {
  return DB_UI_CONFIG[type].color;
}
