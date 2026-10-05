import LaunchClient from "./launch-client";

/**
 * Where a platform sends a person it signs in to Studio: /launch#token=<jws> (docs/LAUNCH.md). The token
 * rides in the fragment, which a browser never sends to a server, so it reaches no access log, proxy log or
 * Referer header. src/proxy.ts lists this path as public, because the session does not exist yet.
 */
export default function LaunchPage() {
  return <LaunchClient />;
}
