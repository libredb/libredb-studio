export type AuditEventType =
  | 'maintenance'
  | 'kill_session'
  | 'masking_config'
  | 'threshold_config'
  | 'connection_test'
  | 'query_execution';

export interface AuditEvent {
  id: string;
  timestamp: string;
  type: AuditEventType;
  action: string;
  target: string;
  connectionName?: string;
  user: string;
  result: 'success' | 'failure';
  duration?: number;
  details?: string;
}

const AUDIT_STORAGE_KEY = 'libredb_audit_log';
const MAX_EVENTS = 1000;

export class AuditRingBuffer {
  private events: AuditEvent[] = [];
  private maxSize: number;

  constructor(maxSize = MAX_EVENTS) {
    this.maxSize = maxSize;
  }

  push(event: Omit<AuditEvent, 'id' | 'timestamp'>) {
    const fullEvent: AuditEvent = {
      ...event,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    };
    this.events.push(fullEvent);
    if (this.events.length > this.maxSize) {
      this.events = this.events.slice(-this.maxSize);
    }
    return fullEvent;
  }

  getAll(): AuditEvent[] {
    return [...this.events];
  }

  getRecent(count: number): AuditEvent[] {
    return this.events.slice(-count);
  }

  filter(opts: {
    type?: AuditEventType;
    result?: 'success' | 'failure';
    connectionName?: string;
    since?: string;
  }): AuditEvent[] {
    return this.events.filter((e) => {
      if (opts.type && e.type !== opts.type) return false;
      if (opts.result && e.result !== opts.result) return false;
      if (opts.connectionName && e.connectionName !== opts.connectionName) return false;
      if (opts.since && e.timestamp < opts.since) return false;
      return true;
    });
  }

  clear() {
    this.events = [];
  }

  get size() {
    return this.events.length;
  }

  toJSON(): AuditEvent[] {
    return this.events;
  }

  loadFrom(events: AuditEvent[]) {
    this.events = events.slice(-this.maxSize);
  }
}

// Global server-side instance
let _serverBuffer: AuditRingBuffer | null = null;

export function getServerAuditBuffer(): AuditRingBuffer {
  if (!_serverBuffer) {
    _serverBuffer = new AuditRingBuffer();
  }
  return _serverBuffer;
}

// Client-side localStorage persistence
export function loadAuditFromStorage(): AuditEvent[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(AUDIT_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

export function saveAuditToStorage(events: AuditEvent[]) {
  if (typeof window === 'undefined') return;
  try {
    const trimmed = events.slice(-MAX_EVENTS);
    localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Storage full, ignore
  }
}
