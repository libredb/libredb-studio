import type { NextConfig } from "next";
import packageJson from "./package.json";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
  },
  // Use standalone output for Docker/Kubernetes deployments
  // For Vercel, this is automatically handled
  output: process.env.DOCKER_BUILD === 'true' ? 'standalone' : undefined,

  // Externalize native modules to reduce bundle size and memory usage
  // These packages will be loaded from node_modules at runtime
  serverExternalPackages: ['pg', 'mysql2', 'mongodb', 'better-sqlite3', 'ssh2'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
