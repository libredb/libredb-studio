import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const inter = Inter({ subsets: ["latin"] });

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
    <html lang="en">
      <body className={`${inter.className} antialiased dark`}>
        {children}
        <Toaster position="bottom-right" theme="dark" />
      </body>
    </html>
  );
}
