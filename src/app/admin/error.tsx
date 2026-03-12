'use client';

import { useEffect } from 'react';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[AdminErrorBoundary]', error.message, error.digest);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-white">
      <div className="max-w-md text-center px-6">
        <h1 className="text-xl font-semibold mb-2">Admin Dashboard Error</h1>
        <p className="text-zinc-400 mb-6 text-sm">
          The admin dashboard encountered an error. You can try again or return
          to the main studio.
        </p>
        {error.digest && (
          <p className="text-zinc-600 text-xs mb-4">
            Error ID: {error.digest}
          </p>
        )}
        <div className="flex gap-3 justify-center">
          <button
            onClick={reset}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Try Again
          </button>
          <button
            onClick={() => { window.location.href = '/'; }}
            className="px-5 py-2.5 border border-zinc-700 hover:border-zinc-500 text-zinc-300 rounded-lg text-sm font-medium transition-colors"
          >
            Back to Studio
          </button>
        </div>
      </div>
    </div>
  );
}
