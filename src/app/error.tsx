"use client";

import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[ErrorBoundary]", error.message, error.digest);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface text-fg">
      <div className="max-w-md text-center px-6">
        <div className="mb-4 text-5xl">!</div>
        <h1 className="text-xl font-semibold mb-2">Something went wrong</h1>
        <p className="text-fg-tertiary mb-6 text-sm">
          LibreDB Studio encountered an unexpected error. You can try again or report this issue.
        </p>
        {error.digest && <p className="text-fg-subtle text-xs mb-4">Error ID: {error.digest}</p>}
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
            className="px-5 py-2.5 border border-edge hover:border-edge-hover text-fg-secondary rounded-lg text-sm font-medium transition-colors"
          >
            Report Issue
          </a>
        </div>
      </div>
    </div>
  );
}
