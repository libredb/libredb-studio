# Login Page

The login page uses a responsive split-panel layout that adapts between OIDC (SSO) and local (email/password) authentication modes.

---

## Architecture

```
src/app/login/
├── page.tsx           # Server component — reads NEXT_PUBLIC_AUTH_PROVIDER env var
└── login-form.tsx     # Client component — all UI and auth logic
```

**`page.tsx`** is a server component with `export const dynamic = 'force-dynamic'` to ensure the auth provider env var is read at runtime (critical for Docker deployments where the env var is not available during build).

**`login-form.tsx`** receives `authProvider` as a prop and renders the appropriate form based on whether the value is `"oidc"` or `"local"` (default).

---

## Layout

### Desktop (lg and above)

```
┌─────────────────────────────┬──────────────────────┐
│                             │                      │
│   Left Panel (55%)          │   Right Panel (45%)  │
│                             │                      │
│   ┌─ Logo ─────────────┐    │   ┌──────────────┐   │
│   │ 🔲 LibreDB Studio  │    │   │ Welcome back │   │
│   └────────────────────┘    │   │              │   │
│                             │   │  [Form]      │   │
│   Hero text                 │   │              │   │
│   "The open-source SQL      │   │  OIDC: SSO   │   │
│    IDE for cloud-native     │   │  button      │   │
│    teams"                   │   │              │   │
│                             │   │  Local:      │   │
│   ┌─────────┐ ┌─────────┐   │   │  email/pass  │   │
│   │Feature 1│ │Feature 2│   │   │  + test btns │   │
│   └─────────┘ └─────────┘   │   │              │   │
│   ┌─────────┐ ┌─────────┐   │   └──────────────┘   │
│   │Feature 3│ │Feature 4│   │                      │
│   └─────────┘ └─────────┘   │                      │
│                             │                      │
│   Supported Databases       │                      │
│   [PG] [MySQL] [MongoDB]..  │                      │
│                             │                      │
└─────────────────────────────┴──────────────────────┘
```

### Mobile (below lg)

```
┌──────────────────────┐
│   🔲 LibreDB Studio  │  ← Compact branding
│  Open-source SQL IDE │
│                      │
│   ┌──────────────┐   │
│   │ Sign in      │   │
│   │              │   │
│   │  [Form]      │   │
│   │              │   │
│   └──────────────┘   │
│                      │
│   [PG] [MySQL] ...   │  ← DB badges
└──────────────────────┘
```

- Left branding panel is hidden (`hidden lg:flex`)
- Mobile branding appears above the card (`lg:hidden`)
- Card title: "Welcome back" (desktop) / "Sign in" (mobile)
- Card description adapts per viewport
- Accessibility: mobile branding uses `<h2>` to avoid duplicate `<h1>` tags

---

## Authentication Modes

### OIDC Mode (`NEXT_PUBLIC_AUTH_PROVIDER=oidc`)

When OIDC is active, the right panel shows:

1. **ShieldCheck icon** with "Single Sign-On" label
2. **"Login with SSO" button** — triggers a full-page redirect to `/api/auth/oidc/login`
3. **Security badges** — "Encrypted" and "OIDC Protected"

The SSO flow uses standard browser redirect (not popup). The OIDC login route handles PKCE, and the callback route creates a local JWT session before redirecting to `/` or `/admin` based on the mapped role.

### Local Mode (`NEXT_PUBLIC_AUTH_PROVIDER=local`, default)

When local auth is active, the right panel shows:

1. **Email/password form** with icon-prefixed inputs
2. **"Sign In" button** — calls `POST /api/auth/login` with JSON body
3. **Quick Access section** — two test buttons (Admin / User) that auto-fill credentials and submit

On successful login, the user is redirected based on their role:
- `admin` → `/admin`
- `user` → `/`

---

## Design System

The login page follows the app's premium dark aesthetic:

| Element | Value | Notes |
|---------|-------|-------|
| Left panel background | `bg-zinc-950` | Matches app background (`--background: #09090b`) |
| Gradient overlay | `from-blue-950/20 to-cyan-950/10` | Subtle blue tint for depth |
| Accent color | `text-blue-400` | App's primary accent |
| Feature cards | `bg-white/[0.03] border-white/[0.05]` | Glassmorphism, matching admin dashboard |
| Feature icon bg | `bg-blue-500/10 border-blue-500/10` | Blue-tinted icon containers |
| Ambient orbs | `bg-blue-500/[0.07]`, `bg-cyan-500/[0.05]` | Soft glow, same pattern as admin dashboard |
| Dot grid | `opacity-[0.04]`, 32px spacing | Decorative texture |
| Panel separator | `bg-white/[0.06]` | 1px right edge line |
| Text hierarchy | `text-white` → `text-zinc-200` → `text-zinc-400` → `text-zinc-500` → `text-zinc-600` | 5-level opacity scale |
| Mobile icon | `bg-zinc-900 border-white/[0.08]` | Dark container with blue glow shadow |
| Form card | `border-muted-foreground/10 shadow-2xl` | Shadcn Card with elevated shadow |

---

## Files

| File | Purpose |
|------|---------|
| `src/app/login/page.tsx` | Server component, reads auth provider env var, forces dynamic rendering |
| `src/app/login/login-form.tsx` | Client component, split-panel layout, OIDC/local form rendering |
| `tests/components/LoginPage.test.tsx` | Component tests — rendering, form submission, OIDC mode |

---

## Environment Variables

| Variable | Default | Effect on Login |
|----------|---------|-----------------|
| `NEXT_PUBLIC_AUTH_PROVIDER` | `local` | `"oidc"` → SSO button, `"local"` → email/password form |
| `NEXT_PUBLIC_APP_VERSION` | — | Displayed in footer as `v{version}` |

---

## Customization

### Changing branding text

Edit the `features` array and hero text in `login-form.tsx`:

```tsx
const features = [
  { icon: Globe, title: '7+ Database Engines', desc: 'PostgreSQL, MySQL, ...' },
  { icon: Zap, title: 'AI-Native Queries', desc: 'Natural language to SQL...' },
  // ...
];
```

Hero text is in the `<h1>` element. The gradient word uses `from-blue-400 to-cyan-400`.

### Changing database badges

Both desktop and mobile lists are separate arrays. Keep them in sync:

```tsx
// Desktop (left panel, line ~131)
{['PostgreSQL', 'MySQL', 'MongoDB', 'Oracle', 'SQL Server'].map(...)}

// Mobile (bottom pills, line ~316)
{['PostgreSQL', 'MySQL', 'MongoDB', 'Oracle', 'SQL Server'].map(...)}
```

### Changing colors

To align with a different brand, update these Tailwind classes:

- **Accent**: Replace `blue-400`, `blue-500`, `blue-950` with your color
- **Gradient text**: `from-blue-400 to-cyan-400` on the hero heading
- **Feature icons**: `bg-blue-500/10 border-blue-500/10` and `text-blue-400`
- **Mobile icon**: `bg-blue-500/20` glow and `text-blue-400` icon
