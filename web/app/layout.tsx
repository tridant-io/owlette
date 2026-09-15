import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { LazyAuthProvider } from "@/components/LazyAuthProvider";
import { Toaster } from "@/components/ui/sonner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Footer } from "@/components/Footer";
import SentryInit from "@/components/SentryInit";
import { SecurityVersionBanner } from "@/components/SecurityVersionBanner";
import { TooltipProvider } from "@/components/ui/tooltip";

const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const siteUrl = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://owlette.app';

export const metadata: Metadata = {
  title: {
    default: "owlette — keep every windows machine running",
    // Every app route sets a short lowercase name (the nav label) and gets
    // "owlette - <name>" in the tab.
    //
    // Pages whose title ALREADY carries the brand opt out with `absolute`, or
    // the template doubles it: /for-ai and /share/[token]. Docs pages
    // deliberately do NOT opt out — they set a bare page name, so the template
    // is what gives them "owlette - Getting Started" instead of a brandless tab.
    template: "owlette - %s",
  },
  description: "owlette keeps your installations running 24/7 — remote monitoring, auto-recovery, and AI-powered fleet management for Windows machines.",
  icons: {
    icon: '/icon.svg',
    shortcut: '/icon.svg',
    apple: '/owlette-icon.png',
  },
  openGraph: {
    title: "owlette — keep every windows machine running",
    description: "owlette keeps your installations running 24/7 — remote monitoring, auto-recovery, and AI-powered fleet management for Windows machines.",
    url: siteUrl,
    siteName: "owlette",
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'owlette dashboard — fleet monitoring and control',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: "owlette — keep every windows machine running",
    description: "owlette keeps your installations running 24/7 — remote monitoring, auto-recovery, and AI-powered fleet management for Windows machines.",
    images: ['/og-image.png'],
  },
  metadataBase: new URL(siteUrl),
  manifest: '/manifest.json',
  alternates: {
    // AI-legible context: a plain-text map for LLM agents (see /llms.txt)
    types: {
      'text/plain': '/llms.txt',
    },
  },
  other: {
    'theme-color': '#0a0f1a',
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Reading request headers opts the app into per-request rendering so the
  // proxy CSP nonce can be applied to Next.js framework inline scripts.
  await headers();
  // Validate Firebase environment variables
  // In development: logs warnings
  // In production: throws error if misconfigured
  // TEMPORARILY DISABLED for initial Railway deployment
  // validateEnvironmentOrThrow();

  return (
    <html lang="en" className="dark scroll-smooth">
      <body
        className={`${geist.variable} ${geistMono.variable} font-sans antialiased text-foreground`}
      >
        <span dangerouslySetInnerHTML={{ __html: `<!--


    :::::..                           ...::::::--:::::::::::......
    :::::....                              :.:::::-:::::::::.  ..:
    ::---------:.                           .:*-.:-:::::::::.   .:
    :::--------.                         :-=+??-.*+-::::::::.   .:
    -::::-----               :-.       ...-**=:.:=**=:::::::.    .
    -:::::--:               -*?*       :--+%=  =-=+*+-::::::.    .
    -::.::-.                 .:.      .:..=?+  :-=+**=::::-:.
    -:..::.                        ...    .*?*=-===***=::--:.
    -::.:.                     ..::..      *%SS%%*=+**=-:--:.
    -:::.                       ....      .?%SSSS%?***=----:.
    --::                          .:-:::. :?%SSS%%%?*+------:
    ---.                            .-===-+??*?*+***++=-----:
    --:                              ::--+-====+++*+++=-----:.
    -:                        ..:::-:--+===+=*+=??%**?=-----:.
                               .:-++*?%%??S%?S%%SS?%%?=-----:.


          ╔═══════════════════════════════════════════╗
          ║                                           ║
          ║"Do you like our owl?"           ║
          ║                                           ║
          ║"It's artificial?"    ║
          ║                                           ║
          ║"Of course it is."               ║
          ║                                           ║
          ║"Must be expensive."  ║
          ║                                           ║
          ║"Very."                          ║
          ║                                           ║
          ╚═══════════════════════════════════════════╝

                          — Blade Runner, 1982


-->` }} style={{ display: 'none' }} />
        <SentryInit />
        <SecurityVersionBanner />
        <ErrorBoundary>
          <LazyAuthProvider>
            <TooltipProvider delayDuration={300}>
              {children}
              <Footer />
              <Toaster theme="dark" />
            </TooltipProvider>
          </LazyAuthProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
