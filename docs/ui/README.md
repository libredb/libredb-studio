# UI Documentation

Reference docs for LibreDB Studio's visual layer — theming and standalone pages.

| Doc | Covers |
|-----|--------|
| [Theming](theming.md) | Tailwind v4 `@theme inline`, shadcn/ui CSS variables, the color palette, and the (currently dark-only) theme model |
| [Login Page](login-page.md) | Responsive split-panel login layout, OIDC vs. local auth modes, and the design system |

## Source map

| Area | Source |
|------|--------|
| Theme variables | `src/app/globals.css` |
| Root layout (dark class) | `src/app/layout.tsx` |
| Login page | `src/app/login/page.tsx`, `src/app/login/login-form.tsx` |

> See also [OIDC SSO](../OIDC.md) for the auth flow and provider setup that the login page drives.
