'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Database, ExternalLink, Lock, Mail, ShieldCheck, UserCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';

function LoginForm() {
  const isOIDC = process.env.NEXT_PUBLIC_AUTH_PROVIDER === 'oidc';
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

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-br from-background via-muted/50 to-background p-4 sm:p-6 lg:p-8">
      <Card className="w-full max-w-md border-muted-foreground/10 shadow-2xl transition-all duration-300 hover:shadow-primary/5">
        <CardHeader className="space-y-4 text-center pb-8">
          <div className="flex justify-center">
            <div className="relative">
              <div className="absolute -inset-1 rounded-full bg-gradient-to-r from-primary to-primary/50 opacity-20 blur" />
              <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-background border shadow-inner">
                <Database className="h-8 w-8 text-primary animate-pulse" />
              </div>
            </div>
          </div>
          <div className="space-y-1">
            <CardTitle className="text-3xl font-bold tracking-tight">LibreDB Studio</CardTitle>
            <CardDescription className="text-balance text-muted-foreground">
              Secure database administration and management portal
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="space-y-8">
          {isOIDC ? (
            <>
              {oidcError && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  Authentication failed. Please try again.
                </div>
              )}
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
                  <span className="bg-background px-2 text-muted-foreground font-medium">Quick Access for Demo</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
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

        <CardFooter className="pt-0 pb-8 flex flex-col items-center gap-2">
          <p className="text-xs text-muted-foreground font-medium text-center max-w-[240px]">
            Enterprise-grade security powered by LibreDB Studio Engine
          </p>
          <span className="text-[10px] text-muted-foreground/60 font-mono">
            v{process.env.NEXT_PUBLIC_APP_VERSION}
          </span>
        </CardFooter>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
