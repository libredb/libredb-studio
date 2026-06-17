// Ambient declarations for side-effect style imports (e.g. `import './globals.css'`).
// TypeScript 6 changed the `types` compiler option to default to `[]`, so it no
// longer auto-includes every `node_modules/@types` package for ambient globals.
// CSS module declarations that bun-types previously provided implicitly must now
// be declared explicitly here.
declare module '*.css';
