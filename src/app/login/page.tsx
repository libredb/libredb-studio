import LoginForm from './login-form';

// Force dynamic rendering so env vars are read at runtime, not build time.
// This is critical for Docker deployments where NEXT_PUBLIC_AUTH_PROVIDER
// is set as a runtime env var (not available during docker build).
export const dynamic = 'force-dynamic';

export default function LoginPage() {
  const authProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER || 'local';
  return <LoginForm authProvider={authProvider} />;
}
