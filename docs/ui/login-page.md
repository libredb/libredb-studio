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
│  LibreDB Studio             │   Right Panel (45%)  │
│                             │                      │
│  The open-source SQL IDE    │   ┌──────────────┐   │
│  that deploys next to       │   │ Welcome back │   │
│  your data                  │   │              │   │
│  <one-sentence subhead>     │   │  [Form]      │   │
│                             │   │              │   │
│  postgres://user@host/app   │ <- signature: one    │
│                             │    line, cycling     │
│  (pg) PostgreSQL (my) MySQL │ <- every engine,     │
│  (lt) SQLite ... (lb)LibreDB│    icon + label      │
│                             │   │  OIDC: SSO   │   │
│  16        24        2      │ <- derived counts    │
│  engines   channels  modes  │   │  or email/pw │   │
│  <one qualifying line each> │   └──────────────┘   │
│  Runs on Linux · macOS · …  │                      │
│  ─────────────────────────  │                      │
│  Open source · github.com…  │ <- one thin row      │
│  (gh)(in)(X)(yt)(ig)(rd)(d) │    + social icons    │
└─────────────────────────────┴──────────────────────┘
```

The panel carries three tiers of weight - thesis, evidence, proof - rather than six blocks at
one weight. That is the whole shape of the redesign, and it is load-bearing rather than
cosmetic: the previous composition (four feature cards, an eleven-pill engine wall, all
twenty-four channel names by group, and a six-card community block) made the panel 1294px
tall in a 900px viewport, so the **page** scrolled and the sign-in card itself was pushed
below the fold. Anything added here has to keep the panel inside the viewport at 1440x900.

Two rules the components record in their own comments, repeated here because they are easy
to undo from the outside:

- **One `mt-auto` in the column, not two.** With an auto margin on both the middle and the
  bottom group the column split its free space in two, and once the content outgrew the
  viewport the groups closed up against each other and simply overflowed.
- **The channel names are deliberately gone.** `LIVE_CHANNELS` still drives the count and
  `DEPLOY_GROUP_LABELS` the four group names, so nothing can go stale, but the hero no
  longer prints two dozen names. `docs/CHANNELS.md` remains the place that lists them.

### Mobile (below lg)

```
┌──────────────────────┐
│    LibreDB Studio    │  <- Compact branding
│  Open-source SQL IDE │
│                      │
│   ┌──────────────┐   │
│   │ Sign in      │   │
│   │              │   │
│   │  [Form]      │   │
│   │              │   │
│   └──────────────┘   │
│                      │
│   [PG] [MySQL] ...   │  <- every engine
│   16 engines · 24 …  │  <- the same claims,
│                      │     joined into a line
│   Open source · gh…  │
│   (gh)(in)(X)(yt)…   │
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

On successful login, the user is redirected based on their role:
- `admin` → `/admin`
- `user` → `/`

On failure, the form surfaces the API's `message` via a toast instead of a
generic error:
- Wrong credentials → `"Invalid email or password"` (401).
- Server not configured (missing `ADMIN_PASSWORD`, or a missing/too-short
  `JWT_SECRET`) → the actionable `AuthConfigError` message (503), e.g. *"Login
  is unavailable: this server has no administrator password configured. Set
  the ADMIN_PASSWORD environment variable and restart the server."* — never a
  misleading "Invalid email or password" (PR #106).

**Zero-config first run:** if `ADMIN_PASSWORD`/`JWT_SECRET` are missing, they
are generated at boot and the admin password is printed once to the server
log instead of the 503 above; see [DISTRIBUTION.md](../DISTRIBUTION.md) for
the full behavior. Set `AUTH_BOOTSTRAP=off` to disable generation and exercise
the 503 path with explicit credentials.

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
| `src/components/login/database-showcase.tsx` | Supported-engine list, both surfaces, from `DB_UI_CONFIG` |
| `src/components/login/deploy-showcase.tsx` | Live install channels by group, both surfaces, from the generated inventory |
| `src/lib/db-showcase.ts` | Showcase order and the derived engine list |
| `src/lib/distribution/channels.generated.ts` | Generated live-channel list (`bun run channels:showcase`) |
| `src/lib/agent/engine-support.ts` | The engines the agent card may claim execution on |
| `tests/components/LoginPage.test.tsx` | Component tests — rendering, form submission, OIDC mode, and the pinned agent claim |
| `e2e/login.spec.ts` | Browser assertions that both showcase blocks render every derived entry, desktop and mobile |

---

## Environment Variables

| Variable | Default | Effect on Login |
|----------|---------|-----------------|
| `NEXT_PUBLIC_AUTH_PROVIDER` | `local` | `"oidc"` → SSO button, `"local"` → email/password form |
| `NEXT_PUBLIC_APP_VERSION` | — | Displayed in footer as `v{version}` |
| `AUTH_BOOTSTRAP` | on | `off`/`false`/`0` (case-insensitive) disables zero-config credential generation, so a missing `ADMIN_PASSWORD`/`JWT_SECRET` surfaces the 503 error above instead |

---

## Customization

### Changing branding text

Edit the `features` array and hero text in `login-form.tsx`. Every count and every
product name in those cards is **derived**, not written: the engine count is
`listShowcaseDatabases().length`, the channel count is `LIVE_CHANNELS.length`, and the
agent card's sentence names the engines in `AGENT_EXECUTION_ENGINES`. Issue #425 exists
because the previous copy typed those answers by hand and stopped tracking the product
three providers and two dozen channels later, so re-introducing a literal here is the one
edit this page asks you not to make. Change the wording around the values freely.

Hero text is in the `<h1>` element. The gradient word uses `from-blue-400 to-cyan-400`.

### Changing the engine and channel lists

You do not edit either list here. Both blocks render one component twice, once per
surface (`variant="desktop"` in the hero, `variant="mobile"` under the sign-in card), and
both read from a single source:

| Block | Component | Source of truth |
|---|---|---|
| Supported Databases | `src/components/login/database-showcase.tsx` | `DB_UI_CONFIG` via `listShowcaseDatabases()` (`src/lib/db-showcase.ts`) — label, brand icon and accent colour all come from the provider's own UI config |
| Proof row (engine / channel / agent-mode counts) | `src/components/login/hero-proof.tsx` | `src/lib/distribution/channels.generated.ts`, generated from `distribution/channels.yaml` by `bun run channels:showcase` and gated in CI; group names from `src/lib/distribution/deploy-groups.ts`; agent-mode engines from `src/lib/agent/engine-support.ts` |
| Connection signature | `src/components/login/connection-signature.tsx` | `ENGINE_URI_SCHEMES` in `src/lib/connection-string-parser.ts`, paired with each engine's own `defaultPort` — it can only show a URI the parser accepts, which is why SQLite, Druid and LibreDB never appear there |

So **adding a provider publishes it on this page**, and **flipping a channel to `live` in
`channels.yaml` publishes it too** — neither needs a component edit. Display order for the
engines is `SHOWCASE_RANK` in `src/lib/db-showcase.ts`, a `Record<DatabaseType, number>`
that fails `bun run typecheck` when a new engine has no rank; the deploy rows are ordered
by `DEPLOY_GROUP_ORDER` and a channel reaches a group through its inventory `category`.

Two constraints on any restyle of these blocks. The desktop copies live inside the
pinned-dark hero and must use the `fill`/`hairline`/`fg` tokens, while the mobile copies
follow the viewer's theme through `muted`/`muted-foreground` — swapping either family
across produces text the colour of its own background in one theme. And the desktop text
sits at `fg-tertiary` deliberately: the two ramp steps below it measure 2.6:1 and 3.9:1 on
this ground, under the 4.5:1 WCAG AA floor for type this small.

### Changing colors

To align with a different brand, update these Tailwind classes:

- **Accent**: Replace `blue-400`, `blue-500`, `blue-950` with your color
- **Gradient text**: `from-blue-400 to-cyan-400` on the hero heading
- **Feature icons**: `bg-blue-500/10 border-blue-500/10` and `text-blue-400`
- **Mobile icon**: `bg-blue-500/20` glow and `text-blue-400` icon
