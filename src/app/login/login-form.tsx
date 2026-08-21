"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ExternalLink, Lock, Mail, ShieldCheck, Shield } from "lucide-react";
import { toast } from "sonner";
import LibreDBLogo from "@/components/libredb-logo";
import { CommunitySection } from "@/components/community-section";
import { ConnectionSignature } from "@/components/login/connection-signature";
import { DatabaseShowcase } from "@/components/login/database-showcase";
import { HeroProof, HERO_CLAIMS } from "@/components/login/hero-proof";
import { WireCompatibleLine } from "@/components/login/wire-compatible-line";

/**
 * The agent half of the mobile summary. Pulled from `HERO_CLAIMS` rather than retyped, so
 * the mobile line states exactly what the desktop figure states about the two modes.
 */
const agentClaimDetail = HERO_CLAIMS.find((claim) => claim.key === "agent")?.detail ?? "";

function LoginFormInner({ authProvider }: { authProvider: string }) {
  const isOIDC = authProvider === "oidc";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const oidcError = searchParams.get("error");

  const handleLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    if (!email || !password) {
      toast.error("Please enter email and password");
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (data.success) {
        toast.success(`Welcome back, ${data.role}!`);
        router.push(data.role === "admin" ? "/admin" : "/");
        router.refresh();
      } else {
        // data.message is the login route's own body ({ success: false, message }); data.error is
        // everything else that can refuse a login POST before or without reaching that body - the
        // proxy's Origin-mismatch 403 (src/proxy.ts) and the shared 429 envelope
        // (createErrorResponse) both carry `error`, not `message`. Without this fallback, a
        // reverse-proxy Host rewrite or a rate-limited legitimate user both see "Invalid email or
        // password" instead of the actionable text naming ALLOWED_ORIGINS or the retry window.
        toast.error(data.message || data.error || "Invalid email or password");
      }
    } catch {
      toast.error("An error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] bg-background">
      {/*
        Left Panel - Branding (hidden on mobile).

        Pinned dark with a nested `dark` class, which re-declares the token
        variables for this subtree only: the panel is a designed dark hero — a
        deep gradient, a dot grid at 4% white, a glow, and a heading that is
        literally `text-white` — and following the theme would put white type on a
        white ground. The sign-in half beside it follows the theme normally.
      */}
      <div className="dark hidden lg:flex lg:w-1/2 xl:w-[55%] relative overflow-hidden">
        <div className="absolute inset-0 bg-surface" />
        <div className="absolute inset-0 bg-gradient-to-b from-blue-950/20 via-transparent to-cyan-950/10" />

        {/* Dot grid pattern */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage: "radial-gradient(circle at 1px 1px, white 1px, transparent 0)",
            backgroundSize: "32px 32px",
          }}
        />

        {/* Ambient glow orbs — blue accent family */}
        <div className="absolute top-1/4 -left-20 w-80 h-80 bg-blue-500/[0.07] rounded-full blur-3xl" />
        <div className="absolute bottom-1/3 right-10 w-64 h-64 bg-cyan-500/[0.05] rounded-full blur-3xl" />

        {/* Right edge separator */}
        <div className="absolute right-0 top-0 bottom-0 w-px bg-fill-strong" />

        {/* Content */}
        <div className="relative z-10 flex flex-col p-12 xl:p-16 w-full overflow-y-auto">
          {/* Top: Logo */}
          <a
            href="https://libredb.org"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 group w-fit"
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-fill-strong border border-hairline-strong group-hover:bg-fill-strong group-hover:border-hairline-strong transition-all duration-200">
              <LibreDBLogo className="h-9 w-9 text-blue-400" />
            </div>
            <span className="text-xl font-semibold text-white tracking-tight group-hover:text-blue-400 transition-colors duration-200">
              LibreDB Studio
            </span>
          </a>

          {/*
            Thesis, then evidence, then the proof numbers - three tiers of weight instead of
            six blocks competing at one weight.

            A single `mt-auto` here, and none below: with `mt-auto` on both the middle and
            the bottom group the column split its free space in two, and once the content
            grew past the viewport the two groups closed up against each other and the panel
            simply overflowed the page (measured at 1294px tall in a 900px viewport, which
            pushed the sign-in card itself below the fold). The content now ends with the
            community row, so one auto margin above it is the whole layout.
          */}
          <div className="space-y-8 mt-auto">
            <div className="space-y-4 max-w-xl">
              <h1 className="text-4xl font-bold text-white tracking-tight leading-[1.1]">
                The open-source SQL IDE that
                <span className="bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
                  {" "}
                  deploys next to your data
                </span>
              </h1>
              {/*
                No longer "deploy with Docker in seconds": Docker is one of two dozen live
                channels (distribution/channels.yaml), and half of the rest are installers,
                so the old line was both an undercount and a contradiction of the deb, rpm,
                Snap, winget, Homebrew and AppImage packages this project ships.
              */}
              <p className="text-base text-fg-tertiary leading-relaxed">
                Point it at a database you already run. Query, explore and manage every one of them from a single
                workspace.
              </p>
            </div>

            <ConnectionSignature />

            {/*
              The pills and the relatives line are ONE block with a 12px gap, not two
              siblings in the 32px rhythm above. Two reasons, and the second is a measurement:
              the line is the second half of the engine list rather than a fourth claim, so it
              belongs to the pills; and this column had no room to give. At 1280x800 the hero
              measured exactly 800px before this change - zero slack - so every pixel added
              here scrolls the page. Folding the two into one block buys back 20px of the 32
              the standalone gap would have cost.
            */}
            <div className="space-y-3">
              <DatabaseShowcase variant="desktop" />
              <WireCompatibleLine variant="desktop" />
            </div>

            <HeroProof />
          </div>

          <div className="mt-8">
            <CommunitySection variant="desktop" />
          </div>
        </div>
      </div>

      {/* Right Panel - Login Form */}
      <div className="flex w-full lg:w-1/2 xl:w-[45%] items-center justify-center p-4 sm:p-6 lg:p-8">
        <div className="w-full max-w-md space-y-8">
          {/* Mobile branding (visible only on mobile) */}
          <a
            href="https://libredb.org"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="LibreDB Studio website"
            className="flex flex-col items-center gap-4 lg:hidden group"
          >
            <div className="relative">
              <div className="absolute -inset-2 rounded-full bg-blue-500/20 blur-lg" />
              <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl bg-raised border border-hairline-strong shadow-lg shadow-blue-500/10 group-hover:border-blue-500/20 transition-all duration-200">
                <LibreDBLogo className="h-12 w-12 text-blue-400" />
              </div>
            </div>
            <div className="text-center space-y-1">
              <h2 className="text-2xl font-bold tracking-tight group-hover:text-blue-400 transition-colors duration-200">
                LibreDB Studio
              </h2>
              <p className="text-sm text-muted-foreground">Open-source SQL IDE for cloud-native teams</p>
            </div>
          </a>

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
                      window.location.href = "/api/auth/oidc/login";
                    }}
                    disabled={isLoading}
                  >
                    <ExternalLink className="h-4 w-4" />
                    {isLoading ? "Redirecting..." : "Login with SSO"}
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
                      {isLoading ? "Authenticating..." : "Sign In"}
                    </Button>
                  </form>
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

          {/*
            Mobile showcase: the same three derived sources as the hero, condensed. The
            deploy block collapses to one line and the agent claim to its own paragraph -
            these tokens follow the viewer's theme, unlike the pinned-dark hero above.
          */}
          <div className="lg:hidden space-y-4">
            <DatabaseShowcase variant="mobile" />
            <WireCompatibleLine variant="mobile" />
            {/*
              The same three claims the desktop hero makes, joined into one line rather than
              re-worded for mobile: `HERO_CLAIMS` is the single source, so a change to the
              agent copy cannot land on one surface and miss the other.
            */}
            <p
              data-testid="agent-claim"
              className="text-[10px] text-center text-muted-foreground leading-relaxed select-none"
            >
              {HERO_CLAIMS.map((claim) => `${claim.value} ${claim.unit}`).join(" · ")} — {agentClaimDetail}
            </p>
            <CommunitySection variant="mobile" />
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
