'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[ErrorBoundary]', error.message, error.digest);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-white">
      <div className="max-w-md text-center px-6">
        <div className="mb-4 text-5xl">!</div>
        <h1 className="text-xl font-semibold mb-2">Something went wrong</h1>
        <p className="text-zinc-400 mb-6 text-sm">
          LibreDB Studio encountered an unexpected error. You can try again or
          report this issue.
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
          <a
            href="https://github.com/libredb/libredb-studio/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="px-5 py-2.5 border border-zinc-700 hover:border-zinc-500 text-zinc-300 rounded-lg text-sm font-medium transition-colors"
          >
            Report Issue
          </a>
        </div>
      </div>
    </div>
  );
}
