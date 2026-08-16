import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface text-fg">
      <div className="max-w-md text-center px-6">
        <div className="text-6xl font-bold text-fg-faint mb-4">404</div>
        <h1 className="text-xl font-semibold mb-2">Page Not Found</h1>
        <p className="text-fg-tertiary mb-6 text-sm">The page you are looking for does not exist or has been moved.</p>
        <div className="flex gap-3 justify-center">
          <Link
            href="/"
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Go to Studio
          </Link>
          <Link
            href="/login"
            className="px-5 py-2.5 border border-edge hover:border-edge-hover text-fg-secondary rounded-lg text-sm font-medium transition-colors"
          >
            Sign In
          </Link>
        </div>
      </div>
    </div>
  );
}
