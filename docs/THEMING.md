# Theming Guide

This document provides a comprehensive guide for understanding and customizing the theming system in LibreDB Studio.

## Overview

LibreDB Studio uses a modern theming architecture built on:

- **Tailwind CSS v4** - CSS-first configuration with `@theme` directive
- **shadcn/ui** - Accessible component library with CSS variable theming
- **CSS Custom Properties** - Dynamic theme switching (dark/light mode)

## Architecture

### Theme Configuration Flow

```
globals.css
    │
    ├── :root (Light mode variables)
    ├── .dark (Dark mode variables)
    │
    └── @theme inline
            │
            └── Maps CSS variables to Tailwind utilities
                    │
                    └── bg-background, text-foreground, etc.
```

### File Structure

```
src/
└── app/
    └── globals.css          # Theme configuration (single source of truth)
```

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

| Variable | Usage |
|----------|-------|
| `--chart-1` | Primary chart color |
| `--chart-2` | Secondary chart color |
| `--chart-3` | Tertiary chart color |
| `--chart-4` | Quaternary chart color |
| `--chart-5` | Quinary chart color |

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

The application uses `next-themes` for theme switching. The `<ThemeProvider>` is configured in the root layout:

```tsx
<ThemeProvider attribute="class" defaultTheme="dark">
  {children}
</ThemeProvider>
```

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

### Step 3: Test Both Modes

Always test changes in both light and dark modes.

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

### Dark Mode Not Working

1. Verify `ThemeProvider` is wrapping your app
2. Check that `.dark` class is applied to `<html>` element
3. Ensure variables are defined in `.dark {}` selector

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

*Last updated: December 2024*
