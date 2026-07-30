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
