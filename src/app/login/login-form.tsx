'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ExternalLink, Lock, Mail, ShieldCheck, UserCheck, Zap, Globe, Shield, Layers } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import LibreDBLogo from '@/components/libredb-logo';

function LoginFormInner({ authProvider }: { authProvider: string }) {
  const isOIDC = authProvider === 'oidc';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const oidcError = searchParams.get('error');

  const handleLogin = async (e?: React.FormEvent, directEmail?: string, directPassword?: string) => {
    if (e) e.preventDefault();
    const loginEmail = directEmail || email;
    const loginPassword = directPassword || password;

    if (!loginEmail || !loginPassword) {
      toast.error('Please enter email and password');
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      });

      const data = await response.json();

      if (data.success) {
        toast.success(`Welcome back, ${data.role}!`);
        router.push(data.role === 'admin' ? '/admin' : '/');
        router.refresh();
      } else {
        toast.error(data.message || 'Invalid email or password');
      }
    } catch {
      toast.error('An error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const features = [
    { icon: Globe, title: '7+ Database Engines', desc: 'PostgreSQL, MySQL, MongoDB, Oracle, SQL Server' },
    { icon: Zap, title: 'AI-Native Queries', desc: 'Natural language to SQL with multi-model LLM support' },
    { icon: Shield, title: 'Zero Install', desc: 'Browser-based — deploy anywhere with Docker in seconds' },
    { icon: Layers, title: 'Real-Time Monitoring', desc: 'Live metrics, schema explorer, and visual ERD diagrams' },
  ];

  return (
    <div className="flex min-h-[100dvh] bg-background">
      {/* Left Panel - Branding (hidden on mobile) */}
      <div className="hidden lg:flex lg:w-1/2 xl:w-[55%] relative overflow-hidden">
        {/* Base background matching app zinc-950 */}
        <div className="absolute inset-0 bg-zinc-950" />
        <div className="absolute inset-0 bg-gradient-to-b from-blue-950/20 via-transparent to-cyan-950/10" />

        {/* Dot grid pattern */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
            backgroundSize: '32px 32px',
          }}
        />

        {/* Ambient glow orbs — blue accent family */}
        <div className="absolute top-1/4 -left-20 w-80 h-80 bg-blue-500/[0.07] rounded-full blur-3xl" />
        <div className="absolute bottom-1/3 right-10 w-64 h-64 bg-cyan-500/[0.05] rounded-full blur-3xl" />

        {/* Right edge separator */}
        <div className="absolute right-0 top-0 bottom-0 w-px bg-white/[0.06]" />

        {/* Content */}
        <div className="relative z-10 flex flex-col justify-between p-12 xl:p-16 w-full">
          {/* Top: Logo */}
          <div className="flex items-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-white/[0.06] border border-white/[0.08]">
              <LibreDBLogo className="h-9 w-9 text-blue-400" />
            </div>
            <span className="text-xl font-semibold text-white tracking-tight">LibreDB Studio</span>
          </div>

          {/* Middle: Hero text + Features */}
          <div className="space-y-10">
            <div className="space-y-4 max-w-lg">
              <h1 className="text-4xl xl:text-5xl font-bold text-white tracking-tight leading-[1.1]">
                The open-source SQL IDE for
                <span className="bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent"> cloud-native teams</span>
              </h1>
              <p className="text-lg text-zinc-400 leading-relaxed">
                Query, explore, and manage all your databases from a single AI-powered interface. Zero install — deploy with Docker in seconds.
              </p>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {features.map((feature) => (
                <div
                  key={feature.title}
                  className="flex gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.05] pointer-events-none select-none"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 border border-blue-500/10">
                    <feature.icon className="h-4 w-4 text-blue-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-zinc-200">{feature.title}</p>
                    <p className="text-xs text-zinc-500 mt-0.5">{feature.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Bottom: DB badges */}
          <div className="space-y-3">
            <p className="text-xs text-zinc-600 uppercase tracking-widest font-medium">Supported Databases</p>
            <div className="flex flex-wrap gap-2">
              {['PostgreSQL', 'MySQL', 'MongoDB', 'Oracle', 'SQL Server'].map((db) => (
                <span
                  key={db}
                  className="text-xs px-3 py-1.5 rounded-full bg-white/[0.04] text-zinc-500 border border-white/[0.05] font-medium"
                >
                  {db}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Right Panel - Login Form */}
      <div className="flex w-full lg:w-1/2 xl:w-[45%] items-center justify-center p-4 sm:p-6 lg:p-8">
        <div className="w-full max-w-md space-y-8">
          {/* Mobile branding (visible only on mobile) */}
          <div className="flex flex-col items-center gap-4 lg:hidden">
            <div className="relative">
              <div className="absolute -inset-2 rounded-full bg-blue-500/20 blur-lg" />
              <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl bg-zinc-900 border border-white/[0.08] shadow-lg shadow-blue-500/10">
                <LibreDBLogo className="h-12 w-12 text-blue-400" />
              </div>
            </div>
            <div className="text-center space-y-1">
              <h2 className="text-2xl font-bold tracking-tight">LibreDB Studio</h2>
              <p className="text-sm text-muted-foreground">Open-source SQL IDE for cloud-native teams</p>
            </div>
          </div>

          <Card className="border-muted-foreground/10 shadow-2xl transition-all duration-300 hover:shadow-primary/5">
            {/* Desktop header inside card */}
            <CardHeader className="space-y-1 text-center pb-6 lg:pt-8">
              <CardTitle className="text-2xl font-bold tracking-tight">
                <span className="hidden lg:inline">Welcome back</span>
                <span className="lg:hidden">Sign in</span>
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                <span className="hidden lg:inline">Sign in to your LibreDB Studio account</span>
                <span className="lg:hidden">Enter your credentials to continue</span>
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              {isOIDC ? (
                <>
                  {oidcError && (
                    <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                      Authentication failed. Please try again.
                    </div>
                  )}

                  <div className="flex flex-col items-center text-center space-y-3 py-2">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                      <ShieldCheck className="h-6 w-6 text-primary" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-foreground">Single Sign-On</p>
                      <p className="text-xs text-muted-foreground">
                        Sign in securely with your organization&apos;s identity provider
                      </p>
                    </div>
                  </div>

                  <Button
                    className="w-full h-11 text-base font-medium shadow-lg shadow-primary/20 active:scale-[0.98] transition-all gap-2"
                    onClick={() => {
                      setIsLoading(true);
                      window.location.href = '/api/auth/oidc/login';
                    }}
                    disabled={isLoading}
                  >
                    <ExternalLink className="h-4 w-4" />
                    {isLoading ? 'Redirecting...' : 'Login with SSO'}
                  </Button>

                  <div className="flex items-center justify-center gap-4 pt-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Lock className="h-3 w-3" />
                      <span>Encrypted</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Shield className="h-3 w-3" />
                      <span>OIDC Protected</span>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <form onSubmit={handleLogin} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="email">Email</Label>
                      <div className="relative group">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground transition-colors group-focus-within:text-primary" />
                        <Input
                          id="email"
                          type="email"
                          placeholder="Enter your email"
                          className="pl-10 h-11 transition-all focus:ring-2 focus:ring-primary/20"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          required
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="password">Password</Label>
                      <div className="relative group">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground transition-colors group-focus-within:text-primary" />
                        <Input
                          id="password"
                          type="password"
                          placeholder="Enter your password"
                          className="pl-10 h-11 transition-all focus:ring-2 focus:ring-primary/20"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          required
                        />
                      </div>
                    </div>
                    <Button
                      className="w-full h-11 text-base font-medium shadow-lg shadow-primary/20 active:scale-[0.98] transition-all"
                      type="submit"
                      disabled={isLoading}
                    >
                      {isLoading ? 'Authenticating...' : 'Sign In'}
                    </Button>
                  </form>

                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t border-muted" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-card px-2 text-muted-foreground font-medium">Quick Access for Demo</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <Button
                      variant="outline"
                      className="h-auto py-3 px-4 flex-col gap-2 hover:border-primary/50 hover:bg-primary/5 transition-all group"
                      onClick={() => handleLogin(undefined, 'admin@libredb.org', 'LibreDB.2026')}
                      disabled={isLoading}
                    >
                      <div className="flex items-center gap-2 font-semibold text-foreground group-hover:text-primary transition-colors">
                        <ShieldCheck className="h-4 w-4" />
                        <span>Admin</span>
                      </div>
                      <Badge variant="secondary" className="font-mono text-[10px] tracking-wider py-0 px-1.5 opacity-80 group-hover:opacity-100">
                        admin@libredb.org
                      </Badge>
                    </Button>

                    <Button
                      variant="outline"
                      className="h-auto py-3 px-4 flex-col gap-2 hover:border-primary/50 hover:bg-primary/5 transition-all group"
                      onClick={() => handleLogin(undefined, 'user@libredb.org', 'LibreDB.2026')}
                      disabled={isLoading}
                    >
                      <div className="flex items-center gap-2 font-semibold text-foreground group-hover:text-primary transition-colors">
                        <UserCheck className="h-4 w-4" />
                        <span>User</span>
                      </div>
                      <Badge variant="secondary" className="font-mono text-[10px] tracking-wider py-0 px-1.5 opacity-80 group-hover:opacity-100">
                        user@libredb.org
                      </Badge>
                    </Button>
                  </div>
                </>
              )}
            </CardContent>

            <CardFooter className="pt-0 pb-6 flex flex-col items-center gap-2">
              <p className="text-xs text-muted-foreground font-medium text-center max-w-[240px]">
                Enterprise-grade security powered by LibreDB Studio Engine
              </p>
              <span className="text-[10px] text-muted-foreground/60 font-mono">
                v{process.env.NEXT_PUBLIC_APP_VERSION}
              </span>
            </CardFooter>
          </Card>

          {/* Mobile feature pills */}
          <div className="flex flex-wrap justify-center gap-2 lg:hidden">
            {['PostgreSQL', 'MySQL', 'MongoDB', 'Oracle', 'SQL Server'].map((db) => (
              <span
                key={db}
                className="text-[10px] px-2.5 py-1 rounded-full bg-muted text-muted-foreground font-medium"
              >
                {db}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginForm({ authProvider }: { authProvider: string }) {
  return (
    <Suspense>
      <LoginFormInner authProvider={authProvider} />
    </Suspense>
  );
}
