import { defineConfig } from 'tsup'
import path from 'path'

export default defineConfig({
  entry: {
    index: 'src/exports/index.ts',
    providers: 'src/exports/providers.ts',
    types: 'src/exports/types.ts',
    components: 'src/exports/components.ts',
    workspace: 'src/exports/workspace.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  tsconfig: 'tsconfig.lib.json',
  treeshake: true,
  external: [
    'react', 'react-dom', 'next',
    // Database drivers — consumers install what they need
    'pg', 'mysql2', 'better-sqlite3', 'oracledb', 'mssql', 'mongodb', 'ioredis',
    // SSH and crypto
    'ssh2',
    // Monaco editor
    'monaco-editor', '@monaco-editor/react',
    // LLM SDKs
    '@google/generative-ai',
    // UI libs that consumers provide
    'elkjs', 'recharts',
    'framer-motion', 'html2canvas',
    '@tanstack/react-table', '@tanstack/react-virtual',
    'react-resizable-panels', 'react-hook-form', '@hookform/resolvers',
    'react-day-picker', 'embla-carousel-react', 'input-otp',
    'sonner', 'vaul', 'cmdk', 'next-themes',
    // Radix primitives
    /^@radix-ui\//,
    // Utilities
    'class-variance-authority', 'clsx', 'tailwind-merge',
    'sql-formatter', 'date-fns', 'zod', 'yaml', 'jose', 'openid-client',
    'lucide-react',
  ],
  esbuildPlugins: [
    {
      name: 'resolve-at-alias',
      setup(build) {
        // Rewrite @/ → ./  and let esbuild resolve from src/
        build.onResolve({ filter: /^@\// }, async (args) => {
          return build.resolve('./' + args.path.slice(2), {
            resolveDir: path.resolve(__dirname, 'src'),
            kind: args.kind,
          })
        })
      },
    },
    {
      name: 'handle-css-and-xyflow',
      setup(build) {
        // Replace CSS imports with empty modules.
        // CSS is handled by the consumer's bundler (Next.js/Vite), not at runtime.
        build.onResolve({ filter: /\.css$/ }, (args) => ({
          path: args.path,
          namespace: 'ignore-css',
        }))
        build.onLoad({ filter: /.*/, namespace: 'ignore-css' }, () => ({
          contents: '',
        }))
        // Mark @xyflow/react (non-CSS) as external
        build.onResolve({ filter: /^@xyflow\/react$/ }, () => ({
          path: '@xyflow/react',
          external: true,
        }))
      },
    },
  ],
})
