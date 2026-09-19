import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { MotionConfig } from "framer-motion";
import "./globals.css";
import { SolanaProviders } from "../lib/solana/wallet-provider";
import { AppStateProvider } from "../lib/app-state";
import { ToastProvider } from "../components/ui/Toast";
import { DemoModeBanner } from "../components/ui/DemoModeBanner";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "ProjectSol — One signature. Automated asset management.",
  description:
    "Connect your Solana wallet, review eligible assets, authorize what you choose, and let ProjectSol handle the rest automatically.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-bg font-sans text-ink antialiased">
        {/* Makes every Framer Motion animation in the tree respect the OS
            prefers-reduced-motion setting -- the CSS rule in globals.css only
            covers real CSS transitions/animations, not Framer's JS-driven ones. */}
        <MotionConfig reducedMotion="user">
          <DemoModeBanner />
          <SolanaProviders>
            <AppStateProvider>
              <ToastProvider>{children}</ToastProvider>
            </AppStateProvider>
          </SolanaProviders>
        </MotionConfig>
      </body>
    </html>
  );
}
