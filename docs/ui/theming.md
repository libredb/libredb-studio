# Theming Guide

This document provides a comprehensive guide for understanding and customizing the theming system in LibreDB Studio.

## Overview

LibreDB Studio uses a modern theming architecture built on:

- **Tailwind CSS v4** - CSS-first configuration with `@theme` directive
- **shadcn/ui** - Accessible component library with CSS variable theming
- **CSS Custom Properties** - Light and dark variable sets, in two layers: the shadcn
  variables in `globals.css` and studio's own semantic tokens in `src/styles/theme.css`

Studio is **dark-first with a runtime light theme**: `next-themes` writes the `dark` class,
the toggle in the header flips it, and the choice persists under the `libredb-theme` storage
key. Dark is the default and the server-rendered assumption.

## Architecture

### Theme Configuration Flow

```
globals.css                       src/styles/theme.css   (shipped as dist/styles.css)
    │                                     │
    ├── :root (shadcn light)              ├── :root (studio light tokens)
    ├── .dark (shadcn dark)               ├── .dark  (studio dark tokens)
    │                                     │
    └── @theme inline                     └── @theme inline
            │                                     │
            └── bg-background, …                  └── bg-surface, text-fg-muted,
                                                     border-hairline, …
```

### File Structure

```
src/
├── app/
│   └── globals.css          # shadcn variables + app-level global rules; imports theme.css
├── styles/
│   └── theme.css            # studio's semantic tokens — the only place a surface colour is written
├── components/
│   ├── theme-provider.tsx   # next-themes provider (class attribute, storageKey libredb-theme)
│   └── theme-toggle.tsx     # two-state dark ↔ light control
└── hooks/
    └── use-effective-theme.ts  # the theme in force, for canvases that cannot read CSS
```

### The studio token layer

The shadcn variables cover the primitives; studio's own chrome — panels, rails, grids, the
editor frame — is written in the semantic tokens of `src/styles/theme.css`. Two ramps:

| Ramp | Tokens (recessed → elevated / brightest → faintest) |
|------|-----------------------------------------------------|
| Surface | `canvas` · `sunken` · `surface` · `raised` · `overlay` (plus `panel`, the translucent card ground) |
| Text | `fg-bright` · `fg` · `fg-secondary` · `fg-tertiary` · `fg-muted` · `fg-subtle` · `fg-faint` |

Alongside them: `hairline` / `hairline-strong` for structural rules, `edge` / `edge-hover` for
the border of a control the user is meant to see, and `fill-subtle` / `fill` / `fill-strong`
for hover, selected and inset grounds. They are consumed as ordinary utilities —
`bg-surface`, `text-fg-muted`, `border-hairline`.

In dark, elevation means lighter; in light it means whiter, and the text ramp inverts around
`fg-muted` (zinc-500), the one value that reads on both grounds. The dark values reproduce the
literals the components carried before the layer existed, so **moving a component onto a token
must be a no-op in dark** — any visible dark-mode change is a bug unless it is deliberate and
called out.

### Surfaces that cannot read CSS

Monaco, Recharts and the `@xyflow` ER diagram paint their own canvas from a JS palette, so they
cannot resolve a token. They read `useEffectiveTheme()` instead, which observes the `dark`
class on `<html>` rather than calling `useTheme()` — that class is where next-themes writes
studio's choice *and* where an embedding host writes its own, so one source answers both
deployments and an embedded studio needs no provider to follow along.

### Embedding

`globals.css` is not packaged, so an app consuming `@libredb/studio` must import the tokens
itself or every `var(--studio-*)` resolves to nothing:

```ts
import "@libredb/studio/styles.css";
```

See [`docs/TOOLCHAIN.md`](../TOOLCHAIN.md) for how that file is staged into `dist/` and what
guards it.

## CSS Variables

### Core Variables

| Variable | Description | Usage |
|----------|-------------|-------|
| `--background` | Page background color | `bg-background` |
| `--foreground` | Default text color | `text-foreground` |
| `--card` | Card/panel background | `bg-card` |
| `--card-foreground` | Card text color | `text-card-foreground` |
| `--popover` | Popover/dropdown background | `bg-popover` |
| `--popover-foreground` | Popover text color | `text-popover-foreground` |
| `--primary` | Primary action color | `bg-primary`, `text-primary` |
| `--primary-foreground` | Text on primary | `text-primary-foreground` |
| `--secondary` | Secondary action color | `bg-secondary` |
| `--secondary-foreground` | Text on secondary | `text-secondary-foreground` |
| `--muted` | Muted/subtle background | `bg-muted` |
| `--muted-foreground` | Muted text color | `text-muted-foreground` |
| `--accent` | Accent/hover background | `bg-accent` |
| `--accent-foreground` | Text on accent | `text-accent-foreground` |
| `--destructive` | Destructive action color | `bg-destructive` |
| `--destructive-foreground` | Text on destructive | `text-destructive-foreground` |
| `--border` | Border color | `border-border` |
| `--input` | Input border color | `border-input` |
| `--ring` | Focus ring color | `ring-ring` |
| `--radius` | Border radius base | `rounded-lg`, `rounded-md` |

### Chart Colors

| Variable | Light (`:root`) | Dark (`.dark`) | Usage |
|----------|-----------------|----------------|-------|
| `--chart-1` | `#e76e50` | `#3b82f6` | Primary chart color |
| `--chart-2` | `#2a9d90` | `#22c55e` | Secondary chart color |
| `--chart-3` | `#274754` | `#f59e0b` | Tertiary chart color |
| `--chart-4` | `#e8c468` | `#a855f7` | Quaternary chart color |
| `--chart-5` | `#f4a462` | `#ec4899` | Quinary chart color |

## Dark Mode

### Current Configuration

LibreDB Studio uses a dark-first design with the following color palette (based on Tailwind Zinc):

```css
.dark {
  --background: #09090b;      /* zinc-950 */
  --foreground: #fafafa;      /* zinc-50 */
  --card: #0a0a0a;            /* near zinc-950 */
  --popover: #0a0a0a;
  --secondary: #27272a;       /* zinc-800 */
  --muted: #27272a;           /* zinc-800 */
  --accent: #27272a;          /* zinc-800 */
  --border: #27272a;          /* zinc-800 */
  --muted-foreground: #a1a1aa; /* zinc-400 */
}
```

### Switching Themes

The layout wraps the app in `next-themes`' provider:

```tsx
<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} storageKey="libredb-theme">
  {children}
</ThemeProvider>
```

Two states only, dark and light — `enableSystem` is off, so there is no third "system" entry in
the cycle. The storage key is deliberately studio's own rather than next-themes' default
`theme`: `enableSystem={false}` does not sanitize a *stored* `"system"`, it writes it to the
class list verbatim, so a key that a previous system-enabled build could have written is a key
that can hand the document a `class="system"` and no palette at all.

Anything that renders differently per theme must be guarded against hydration mismatch — the
server has no document to read, so `useEffectiveTheme()` answers `"dark"` there and the toggle
renders a neutral label until it has hydrated.

## Tailwind v4 Integration

### The `@theme inline` Directive

Tailwind CSS v4 introduces CSS-first configuration. The `@theme inline` directive maps CSS variables to Tailwind utility classes:

```css
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  /* ... */
}
```

This enables using semantic class names:

```jsx
<div className="bg-background text-foreground">
  <div className="bg-card border-border">
    Content
  </div>
</div>
```

### IDE Warnings

Your IDE may show warnings like `Unknown at rule @theme`. This is expected because:
- Tailwind v4's `@theme` directive is new
- CSS validators don't recognize it yet
- **It works correctly** - the build succeeds

To suppress these warnings in VS Code, add to `.vscode/settings.json`:

```json
{
  "css.lint.unknownAtRules": "ignore"
}
```

## Best Practices

### DO Use Theme Variables

```jsx
// Good - uses theme variables
<div className="bg-background text-foreground border-border">
<span className="text-muted-foreground">
<button className="bg-primary text-primary-foreground hover:bg-accent">
```

### DON'T Use Hardcoded Colors

```jsx
// Bad - hardcoded colors
<div className="bg-[#050505] text-white border-[#262626]">
<span className="text-zinc-500">
<button className="bg-zinc-900 hover:bg-zinc-800">
```

### Opacity Modifiers

Use opacity modifiers with theme variables:

```jsx
<div className="bg-accent/50">        {/* 50% opacity */}
<span className="text-muted-foreground/70">  {/* 70% opacity */}
<div className="border-border/30">    {/* 30% opacity */}
```

## Customizing the Theme

### Step 1: Modify CSS Variables

Edit `src/app/globals.css`:

```css
.dark {
  /* Change the primary color */
  --primary: #3b82f6;  /* blue-500 */
  --primary-foreground: #ffffff;

  /* Change the accent color */
  --accent: #1e3a5f;
}
```

### Step 2: Verify Mappings

Ensure `@theme inline` maps your variables:

```css
@theme inline {
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-accent: var(--accent);
}
```

### Step 3: Test in Both Themes

Both variable sets are rendered at runtime, so a new colour is only half-added until it has a
value in each. Verify with the header toggle, not by reasoning about the values: a token that
is legible in dark and 2:1 against a white ground is a token that ships an unreadable light
theme.

## Component-Specific Theming

### Buttons

shadcn/ui buttons use theme variables automatically:

```jsx
<Button variant="default">   {/* bg-primary */}
<Button variant="secondary"> {/* bg-secondary */}
<Button variant="outline">   {/* border-input */}
<Button variant="ghost">     {/* hover:bg-accent */}
<Button variant="destructive"> {/* bg-destructive */}
```

### Cards

```jsx
<Card>  {/* bg-card border-border */}
  <CardHeader>
    <CardTitle>   {/* text-card-foreground */}
```

### Dropdowns & Popovers

```jsx
<DropdownMenuContent>  {/* bg-popover text-popover-foreground */}
```

### Inputs

```jsx
<Input>  {/* bg-background border-input */}
```

## Adding New Colors

### Step 1: Define Variables

```css
:root {
  --warning: #f59e0b;
  --warning-foreground: #ffffff;
}

.dark {
  --warning: #d97706;
  --warning-foreground: #ffffff;
}
```

### Step 2: Add Theme Mapping

```css
@theme inline {
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
}
```

### Step 3: Use in Components

```jsx
<div className="bg-warning text-warning-foreground">
  Warning message
</div>
```

## Troubleshooting

### Colors Not Applying

1. Check that the variable is defined in both `:root` and `.dark`
2. Verify the `@theme inline` mapping exists
3. Ensure you're using the correct class name (`bg-card` not `bg-[--card]`)

### A Theme Does Not Take Effect

1. Check the `dark` class on `<html>` — `next-themes` toggles it there; if it never changes, the
   `<ThemeProvider>` is missing or a stored value is being written verbatim (see
   [Switching Themes](#switching-themes))
2. Ensure the variable is defined in **both** the `:root` and `.dark` selectors — a token that
   exists in one palette only silently resolves to nothing in the other
3. Confirm `@theme inline` maps the variable to a `--color-*` utility. `inline` is required: a
   plain `@theme` resolves the value at build time and freezes whichever palette was in scope
4. Embedded in a host app: confirm the host imports `@libredb/studio/styles.css`

### Build Errors

1. Run `bun run build` to check for CSS syntax errors
2. Verify all variables are properly closed
3. Check for typos in variable names

## Resources

### Official Documentation

- [shadcn/ui Theming](https://ui.shadcn.com/docs/theming)
- [shadcn/ui Tailwind v4](https://ui.shadcn.com/docs/tailwind-v4)
- [Tailwind CSS v4 Documentation](https://tailwindcss.com/docs)
- [next-themes](https://github.com/pacocoursey/next-themes)

### Theme Generators

- [tweakcn](https://tweakcn.com/) - Interactive shadcn/ui theme editor
- [shadcn Theme Generator](https://ui.shadcn.com/themes) - Official theme generator

### Color References

- [Tailwind Zinc Palette](https://tailwindcss.com/docs/customizing-colors)
- [OKLCH Color Space](https://oklch.com/) - Modern color space for themes

## Color Palette Reference

### Light Mode (Default)

| Variable | Hex | Description |
|----------|-----|-------------|
| background | `#ffffff` | White |
| foreground | `#0a0a0a` | Near black |
| card | `#ffffff` | White |
| primary | `#171717` | Near black |
| secondary | `#f5f5f5` | Light gray |
| muted | `#f5f5f5` | Light gray |
| muted-foreground | `#737373` | Medium gray |
| accent | `#f5f5f5` | Light gray |
| border | `#e5e5e5` | Gray |

### Dark Mode

| Variable | Hex | Tailwind | Description |
|----------|-----|----------|-------------|
| background | `#09090b` | zinc-950 | Near black |
| foreground | `#fafafa` | zinc-50 | Near white |
| card | `#0a0a0a` | - | Dark |
| primary | `#fafafa` | zinc-50 | Near white |
| secondary | `#27272a` | zinc-800 | Dark gray |
| muted | `#27272a` | zinc-800 | Dark gray |
| accent | `#27272a` | zinc-800 | Dark gray |
| border | `#27272a` | zinc-800 | Dark gray |
| muted-foreground | `#a1a1aa` | zinc-400 | Medium gray |

---

*Last updated: June 2026*
