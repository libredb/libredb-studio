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
  // `cassandra-driver` is pure JavaScript, unlike the rest of this list, and it is
  // here for a different reason: it does `require('kerberos')` inside a try/catch as
  // an OPTIONAL dependency, so bundling it makes the build try to resolve a module
  // nobody installed. Externalizing leaves the try/catch to fail at runtime the way
  // the driver intends.
  serverExternalPackages: ["pg", "mysql2", "mongodb", "better-sqlite3", "ssh2", "cassandra-driver"],
};

export default nextConfig;
