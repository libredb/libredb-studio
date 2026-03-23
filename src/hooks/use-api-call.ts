'use client';

import { useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ApiErrorCode } from '@/lib/api/error-codes';
import type { ApiErrorResponse } from '@/lib/api/errors';

export function useApiCall() {
  const [error, setError] = useState<ApiErrorResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const mountedRef = useRef(true);

  // Track mount state
  // (cleanup handled by caller via useEffect return)

  const clearError = useCallback(() => setError(null), []);

  const call = useCallback(async <T>(
    url: string,
    options?: RequestInit
  ): Promise<T | null> => {
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(url, options);

      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: res.statusText || 'Request failed',
          statusCode: res.status,
        }));

        const apiError: ApiErrorResponse = {
          error: body.error || 'Request failed',
          code: body.code,
          statusCode: body.statusCode || res.status,
          retryable: body.retryable,
          details: body.details,
        };

        // Auto-redirect on 401
        if (res.status === 401) {
          router.push('/login');
          return null;
        }

        if (mountedRef.current) setError(apiError);
        return null;
      }

      const data = await res.json();
      return data as T;
    } catch (err) {
      // Network error
      const apiError: ApiErrorResponse = {
        error: err instanceof Error ? err.message : 'Network error',
        code: ApiErrorCode.NETWORK_ERROR,
        statusCode: 0,
        retryable: true,
      };
      if (mountedRef.current) setError(apiError);
      return null;
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [router]);

  return { call, error, isLoading, clearError };
}
