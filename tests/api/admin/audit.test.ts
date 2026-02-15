import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, parseResponseJSON } from '../../helpers/mock-next';
import type { AuditEvent } from '@/lib/audit';

// ─── Mock audit buffer ──────────────────────────────────────────────────────
const mockEvents: AuditEvent[] = [
  {
    id: 'evt-1',
    timestamp: '2026-02-14T10:00:00.000Z',
    type: 'maintenance',
    action: 'vacuum',
    target: 'users',
    user: 'admin',
    result: 'success',
    duration: 150,
  },
  {
    id: 'evt-2',
    timestamp: '2026-02-14T10:05:00.000Z',
    type: 'query_execution',
    action: 'SELECT',
    target: 'orders',
    user: 'admin',
    result: 'success',
    duration: 25,
  },
];

const mockBuffer = {
  push: mock((event: Omit<AuditEvent, 'id' | 'timestamp'>) => ({
    ...event,
    id: `evt-${Date.now()}`,
    timestamp: new Date().toISOString(),
  })),
  getRecent: mock((count: number) => mockEvents.slice(-count)),
  filter: mock((opts: { type?: string }) => {
    if (opts.type) return mockEvents.filter(e => e.type === opts.type);
    return mockEvents;
  }),
  getAll: mock(() => mockEvents),
  size: mockEvents.length,
  clear: mock(() => {}),
};

const mockGetSession = mock(async (): Promise<{ role: string; username: string } | null> => ({ role: 'admin', username: 'admin' }));

// ─── Mock @/lib/auth BEFORE importing the route ─────────────────────────────
mock.module('@/lib/auth', () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => 'mock-token'),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

// ─── Mock @/lib/audit BEFORE importing the route ────────────────────────────
mock.module('@/lib/audit', () => ({
  getServerAuditBuffer: mock(() => mockBuffer),
  AuditRingBuffer: class {},
  loadAuditFromStorage: mock(() => []),
  saveAuditToStorage: mock(() => {}),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { GET, POST } = await import('@/app/api/admin/audit/route');

// ─── Tests ──────────────────────────────────────────────────────────────────
describe('/api/admin/audit', () => {
  beforeEach(() => {
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async (): Promise<{ role: string; username: string } | null> => ({ role: 'admin', username: 'admin' }));
    mockBuffer.push.mockClear();
    mockBuffer.getRecent.mockClear();
    mockBuffer.filter.mockClear();
  });

  describe('GET /api/admin/audit', () => {
    test('returns events as admin', async () => {
      const req = createMockRequest('/api/admin/audit');

      const res = await GET(req);
      const data = await parseResponseJSON<{ events: AuditEvent[]; total: number }>(res);

      expect(res.status).toBe(200);
      expect(data.events).toBeArray();
      expect(data.total).toBe(mockEvents.length);
    });

    test('returns 403 for non-admin', async () => {
      mockGetSession.mockResolvedValueOnce({ role: 'user', username: 'user' });

      const req = createMockRequest('/api/admin/audit');

      const res = await GET(req);
      const data = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(403);
      expect(data.error).toContain('Unauthorized');
    });

    test('filters by type when type param is provided', async () => {
      const req = createMockRequest('/api/admin/audit?type=maintenance');

      const res = await GET(req);
      const data = await parseResponseJSON<{ events: AuditEvent[] }>(res);

      expect(res.status).toBe(200);
      expect(mockBuffer.filter).toHaveBeenCalled();
      expect(data.events).toBeArray();
    });
  });

  describe('POST /api/admin/audit', () => {
    test('creates event as admin', async () => {
      const req = createMockRequest('/api/admin/audit', {
        method: 'POST',
        body: {
          type: 'maintenance',
          action: 'analyze',
          target: 'products',
          result: 'success',
        },
      });

      const res = await POST(req);
      const data = await parseResponseJSON<{ event: AuditEvent }>(res);

      expect(res.status).toBe(200);
      expect(data.event).toBeDefined();
      expect(mockBuffer.push).toHaveBeenCalledTimes(1);
      // Verify user was injected from session
      const pushCall = mockBuffer.push.mock.calls[0][0] as Record<string, unknown>;
      expect(pushCall.user).toBe('admin');
    });

    test('returns 403 for non-admin on POST', async () => {
      mockGetSession.mockResolvedValueOnce({ role: 'user', username: 'user' });

      const req = createMockRequest('/api/admin/audit', {
        method: 'POST',
        body: {
          type: 'maintenance',
          action: 'vacuum',
          target: 'users',
          result: 'success',
        },
      });

      const res = await POST(req);
      const data = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(403);
      expect(data.error).toContain('Unauthorized');
    });

    test('returns 500 on error', async () => {
      mockBuffer.push.mockImplementationOnce(() => {
        throw new Error('Buffer full');
      });

      const req = createMockRequest('/api/admin/audit', {
        method: 'POST',
        body: {
          type: 'maintenance',
          action: 'vacuum',
          target: 'users',
          result: 'success',
        },
      });

      const res = await POST(req);
      const data = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(500);
      expect(data.error).toBe('Buffer full');
    });
  });
});
