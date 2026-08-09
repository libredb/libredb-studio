---
paths:
  - "src/components/**"
  - "src/workspace/**"
  - "src/**/*.tsx"
  - "src/app/globals.css"
---

# Platform Integration Rules (npm package `@libredb/studio`)

Studio is consumed by libredb-platform as an npm package via `build:lib` (tsup). These rules prevent silent style/layout breakage that only appears when embedded in platform — not in standalone studio. They apply whenever you touch components, `.tsx` files, the workspace shell, or `globals.css`.

## Tailwind CSS Rules

| Do | Don't | Why |
|----|-------|-----|
| `text-xs`, `text-sm` (standard) | `text-body`, `text-data` (custom @theme) | `tailwind-merge` strips custom tokens silently |
| `text-[0.625rem]` (arbitrary value) | `text-label` (custom @theme) | Arbitrary values are twMerge-safe |
| `font-medium`, `font-normal` | `font-bold` everywhere | Studio is compact IDE, lighter weights |
| `w-3 h-3`, `w-3.5 h-3.5` (icons) | `w-4 h-4` or larger | Studio icons smaller than platform |

**Never define custom text tokens in `@theme` block.** `tailwind-merge` (used in `cn()`) interprets `text-body` as a color utility, not font-size. When combined with `text-muted-foreground`, twMerge silently removes `text-body` → no font-size applied → browser default 16px. Invisible in standalone studio (Tailwind generates the CSS) but breaks embedded mode.

## Lucide Icon Rules

Always pass `strokeWidth={1.5}` to every Lucide icon:
```tsx
<Lock strokeWidth={1.5} className="w-3 h-3" />
```
Lucide defaults to `strokeWidth=2` and emits `width="24" height="24"` HTML attributes. Custom DB icons use `strokeWidth=1.5` without HTML size attributes. Without this prop, Lucide icons appear thicker and potentially larger than custom icons.

## Component Rules

- **Small icon buttons:** Use plain `<button className="p-1 rounded ...">` instead of shadcn `<Button size="icon">`. Platform's Button CSS can override studio's size classes due to specificity.
- **Responsive classes:** `md:hidden`, `hidden md:block` etc. must work. If a component is in a tsup chunk, verify platform's `@source` scans that chunk.

## Platform-Side Requirements

Platform's `globals.css` must scan ALL studio dist files (tsup creates chunks):
```css
@source "../../node_modules/@libredb/studio/dist/workspace.mjs";
@source "../../node_modules/@libredb/studio/dist/chunk-*.mjs";
```
Without chunk scanning, responsive/utility classes in chunked components won't generate CSS.

**Monaco assets are NOT shipped either** (same `files` restriction). Standalone studio stages
`node_modules/monaco-editor/min/vs` into `public/monaco/vs` at build time (`scripts/copy-monaco.mjs`,
issue #247) and points the loader at `/monaco/vs`; embedded studio resolves that path against
*platform's* origin, so platform must serve it too:

```bash
# platform build step — monaco-editor arrives transitively with @libredb/studio
cp -r node_modules/monaco-editor/min/vs public/monaco/vs
```

Serving them from a different path instead is fine — set `NEXT_PUBLIC_MONACO_VS_PATH` in platform.
Skipping both leaves the editor pane a spinner that never resolves (404s on `/monaco/vs/loader.js`),
in embedded mode only.

**Studio's `globals.css` is NOT shipped** (`package.json` `files` is `["dist","bin"]`), so anything
expressed as a global CSS rule instead of a utility class exists in standalone studio only. Platform
must replicate those rules in its own `globals.css`. Currently that means the cursor-affordance block
(Tailwind v4 dropped `cursor: pointer` from the button reset) — studio deliberately uses plain
`<button>` for small icon buttons per the Component Rules above, so without it embedded studio shows
a text/default cursor on those. Keep this list in sync when adding global rules.

## Verification Workflow

After any UI change in studio:
1. `bun run build:lib` — rebuild tsup dist
2. `cp -r dist/* ../libredb-platform/node_modules/@libredb/studio/dist/` — copy to platform
3. `rm -rf ../libredb-platform/.next` — clear platform cache (for CSS changes)
4. Restart platform dev server and verify at `localhost:3000/workspace`

## Security Headers (`@libredb/studio/security`)

The package ships the knowledge; the application ships the enforcement. Every server-side control
in Studio (headers, rate limiting, route auth, audit) is application-layer and does **not** reach
platform through the package — platform supplies its own backend and its own `next.config`. What
the package does ship is the policy Monaco and Studio actually require, so platform adopts a
correct CSP in one line instead of choosing between one that breaks the editor and one that
protects nothing:

```ts
import { securityHeaders, studioCspDirectives } from "@libredb/studio/security";

// Ready-to-spread header map, CSP already serialized.
const headers = securityHeaders({
  monacoVsPath: process.env.NEXT_PUBLIC_MONACO_VS_PATH,
  extra: { "connect-src": ["https://api.platform.example"] },
});

// Or take the structured directives and merge them into a policy platform already builds.
const directives = studioCspDirectives();
```

Four things to know before using it:

- **`img-src` must keep `data:` and `font-src` must keep `data:`.** `@zumer/snapdom` rasterizes the
  ER diagram (`src/components/schema-diagram/export.ts`) and the chart PNG export
  (`src/components/DataCharts.tsx`) through a `data:image/svg+xml` URL, and Monaco's
  `editor.main.css` embeds the codicon font as a base64 `data:` URI. Without them the editor keeps
  working while every glyph silently disappears, and both exports throw where the blocked `data:`
  URL would have loaded — each call site catches that and reports it as a destructive toast
  (`SchemaDiagram.tsx`'s `exportDiagram`, `DataCharts.tsx`'s `exportChart`), so it fails loudly
  rather than silently, but it fails.
- **`worker-src` must keep `blob:`.** Monaco's bundled language workers (json/css/html/typescript,
  and the default worker used for every other language, including this app's SQL editor) are not
  same-origin module workers — Monaco's own worker factory wraps each worker script in a
  `new Blob([...])` + `importScripts(...)` and constructs the Worker from that `blob:` URL, so it
  can load the worker code regardless of Monaco's own origin. This was documented as "no `blob:`
  worker exists anywhere" before the end-to-end security-headers stage proved otherwise against a
  real production build — the exact kind of directive a platform developer assembling their own CSP
  by hand, or cherry-picking from `studioCspDirectives()`, would drop as apparently unused. Without
  it Monaco's editor pane fails to load its language workers, silently, in embedded mode only.
- **`script-src` and `style-src` need `'unsafe-inline'` and cannot use a nonce** while the pages
  are statically prerendered. `'unsafe-eval'` is not needed and must not be added.
- **`frame-ancestors 'none'` is safe for the embedded path.** Platform imports Studio as React
  components and never frames a Studio page. If that ever changes, pass an `extra` entry rather
  than dropping the directive.

Serve Monaco from platform's own origin (see the Monaco assets note above) or pass an absolute
`monacoVsPath` — an absolute URL adds its origin to `script-src` and `worker-src` automatically.
