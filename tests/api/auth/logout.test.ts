import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { parseResponseJSON } from '../../helpers/mock-next';

// ─── Mock @/lib/auth BEFORE importing the route ─────────────────────────────
const mockLogout = mock(async () => {});

mock.module('@/lib/auth', () => ({
  login: mock(async () => {}),
  signJWT: mock(async () => 'mock-token'),
  verifyJWT: mock(async () => null),
  getSession: mock(async () => null),
  logout: mockLogout,
}));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockBuildLogoutUrl = mock((_returnTo: string) => null as string | null);

const mockGetPublicOrigin = mock(
  (req: Request) => new URL(req.url).origin
);

mock.module('@/lib/oidc', () => ({
  buildLogoutUrl: mockBuildLogoutUrl,
  getPublicOrigin: mockGetPublicOrigin,
  getOIDCConfig: mock(() => ({})),
  discoverProvider: mock(async () => ({})),
  generateAuthUrl: mock(async () => ({})),
  encryptState: mock(async () => ''),
  decryptState: mock(async () => ({})),
  exchangeCode: mock(async () => ({})),
  mapOIDCRole: mock(() => 'user'),
  resetDiscoveryCache: mock(() => {}),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import('@/app/api/auth/logout/route');

function makeRequest(url = 'http://localhost:3000/api/auth/logout') {
  return new Request(url, { method: 'POST' });
}

// ─── Tests (local auth mode) ────────────────────────────────────────────────
describe('POST /api/auth/logout (local)', () => {
  beforeEach(() => {
    mockLogout.mockClear();
    mockBuildLogoutUrl.mockClear();
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = 'local';
  });

  test('returns 200 with success true', async () => {
    const res = await POST(makeRequest() as never);
    const data = await parseResponseJSON<{ success: boolean }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
  });

  test('calls logout() once', async () => {
    await POST(makeRequest() as never);

    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  test('does not return redirectUrl in local mode', async () => {
    const res = await POST(makeRequest() as never);
    const data = await parseResponseJSON<{ success: boolean; redirectUrl?: string }>(res);

    expect(data.redirectUrl).toBeUndefined();
  });

  test('multiple logouts all succeed', async () => {
    const res1 = await POST(makeRequest() as never);
    const res2 = await POST(makeRequest() as never);
    const res3 = await POST(makeRequest() as never);

    const data1 = await parseResponseJSON<{ success: boolean }>(res1);
    const data2 = await parseResponseJSON<{ success: boolean }>(res2);
    const data3 = await parseResponseJSON<{ success: boolean }>(res3);

    expect(data1.success).toBe(true);
    expect(data2.success).toBe(true);
    expect(data3.success).toBe(true);
    expect(mockLogout).toHaveBeenCalledTimes(3);
  });
});

// ─── Tests (OIDC auth mode) ─────────────────────────────────────────────────
describe('POST /api/auth/logout (oidc)', () => {
  beforeEach(() => {
    mockLogout.mockClear();
    mockBuildLogoutUrl.mockClear();
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = 'oidc';
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = 'local';
  });

  test('returns redirectUrl when OIDC logout URL is available', async () => {
    mockBuildLogoutUrl.mockReturnValue(
      'https://auth0.com/v2/logout?client_id=abc&returnTo=http://localhost:3000/login'
    );

    const res = await POST(makeRequest() as never);
    const data = await parseResponseJSON<{ success: boolean; redirectUrl?: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.redirectUrl).toBe(
      'https://auth0.com/v2/logout?client_id=abc&returnTo=http://localhost:3000/login'
    );
  });

  test('calls buildLogoutUrl with correct returnTo', async () => {
    mockBuildLogoutUrl.mockReturnValue('https://auth0.com/v2/logout');

    await POST(makeRequest('http://localhost:3000/api/auth/logout') as never);

    expect(mockBuildLogoutUrl).toHaveBeenCalledWith('http://localhost:3000/login');
  });

  test('returns success without redirectUrl when buildLogoutUrl returns null', async () => {
    mockBuildLogoutUrl.mockReturnValue(null);

    const res = await POST(makeRequest() as never);
    const data = await parseResponseJSON<{ success: boolean; redirectUrl?: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.redirectUrl).toBeUndefined();
  });

  test('calls logout() even in OIDC mode', async () => {
    mockBuildLogoutUrl.mockReturnValue('https://auth0.com/v2/logout');

    await POST(makeRequest() as never);

    expect(mockLogout).toHaveBeenCalledTimes(1);
  });
});

// ─── Error path ──────────────────────────────────────────────────────────────
describe('POST /api/auth/logout (error handling)', () => {
  beforeEach(() => {
    mockLogout.mockClear();
    mockBuildLogoutUrl.mockClear();
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = 'local';
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = 'local';
  });

  test('returns error response when logout() throws', async () => {
    mockLogout.mockImplementation(() => { throw new Error('cookie store unavailable'); });

    const res = await POST(makeRequest() as never);
    const data = await parseResponseJSON<{ error: string; statusCode: number }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('cookie store unavailable');
    expect(data.statusCode).toBe(500);
  });

  test('returns error response when logout() rejects with async error', async () => {
    mockLogout.mockImplementation(async () => { throw new Error('async logout failure'); });

    const res = await POST(makeRequest() as never);
    const data = await parseResponseJSON<{ error: string; statusCode: number }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('async logout failure');
  });
});
