import LoginForm from "./login-form";

// Force dynamic rendering so env vars are read at runtime, not build time.
// This is critical for Docker deployments where NEXT_PUBLIC_AUTH_PROVIDER
// is set as a runtime env var (not available during docker build).
export const dynamic = "force-dynamic";

export default function LoginPage() {
  const authProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER || "local";
  // Server-side only: the demo account's credentials never reach the browser,
  // only the fact that a demo exists. Absent either half, the button is not
  // rendered and POST /api/auth/demo answers 404.
  const demoEnabled = Boolean(process.env.DEMO_EMAIL && process.env.DEMO_PASSWORD);
  return <LoginForm authProvider={authProvider} demoEnabled={demoEnabled} />;
}
