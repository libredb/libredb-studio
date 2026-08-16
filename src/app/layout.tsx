import { GeistMono } from "geist/font/mono";
// Self-hosted Geist (the `geist` package wraps next/font/local around the woff2
// files it ships). next/font/google would fetch fonts.googleapis.com at BUILD
// time, so `next build` failed in offline or egress-restricted environments;
// the rendered output is identical since Next self-hosts either way. The CSS
// variable names must stay --font-geist-sans/mono: globals.css maps them to
// --font-sans/--font-mono.
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "LibreDB Studio | Universal Database Editor",
  description: "Manage PostgreSQL, MySQL, MongoDB, and Redis in one web-based interface.",
  icons: {
    icon: [
      { url: "/favicon.ico?v=2", sizes: "any" },
      { url: "/logo.svg?v=2", type: "image/svg+xml" },
    ],
    shortcut: "/favicon.ico?v=2",
    apple: "/favicon-32x32.png?v=2",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning is scoped to <html>/<body> only: browser extensions
    // (Grammarly, dark-mode injectors, ...) mutate attributes on these two elements
    // before React hydrates. It suppresses attribute/text mismatches on THESE nodes
    // alone — real hydration bugs inside {children} are still reported.
    <html lang="en" suppressHydrationWarning>
      {/*
        The `dark` class used to be written here, which pinned standalone studio to
        one theme. It is now owned by ThemeProvider, which writes it onto <html>
        (`attribute="class"`) and restores the user's choice before paint.
      */}
      <body suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable} antialiased font-sans`}>
        <ThemeProvider>
          {children}
          {/* No `theme` prop: Toaster reads next-themes itself, so it follows. */}
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
