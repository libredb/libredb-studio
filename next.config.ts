import type { NextConfig } from "next";
import packageJson from "./package.json";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
  },
  // Use standalone output for Docker/Kubernetes deployments
  // For Vercel, this is automatically handled
  output: process.env.DOCKER_BUILD === "true" ? "standalone" : undefined,

  // Externalize native modules to reduce bundle size and memory usage
  // These packages will be loaded from node_modules at runtime
  serverExternalPackages: ["pg", "mysql2", "mongodb", "better-sqlite3", "ssh2"],

  experimental: {
    // Rewrite barrel imports to per-module ones at build time. These five are the
    // barrels this app imports by name and only ever uses a handful of members of —
    // `lucide-react` most of all, where a single `import { Play } from "lucide-react"`
    // otherwise pulls the whole icon set into the module graph before tree-shaking
    // gets a chance. Purely a build-time transform: no source or behaviour changes.
    optimizePackageImports: ["lucide-react", "recharts", "@xyflow/react", "framer-motion", "date-fns"],
  },
};

export default nextConfig;
