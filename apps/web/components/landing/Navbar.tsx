"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import clsx from "clsx";
import { Wordmark } from "../ui/Wordmark";
import { WalletButton } from "../app/WalletButton";

const NAV_ITEMS = [
  { label: "Product", href: "#product" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Security", href: "#security" },
  { label: "Dashboard", href: "/app" },
];

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 8);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <motion.header
      initial={{ opacity: 0, y: -16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className={clsx(
        "fixed inset-x-0 top-0 z-50 transition-all duration-500 ease-premium",
        scrolled ? "bg-black/90 border-b border-white/10 py-3" : "border-b border-transparent py-5",
      )}
    >
      <nav className="mx-auto flex max-w-7xl items-center justify-between px-6">
        <Link href="/" className="focus-ring flex items-center rounded-md">
          <Wordmark className="text-[17px]" />
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {NAV_ITEMS.map((item) => (
            <Link key={item.label} href={item.href} className="focus-ring group relative rounded-md text-sm text-ink-muted transition-colors hover:text-ink">
              {item.label}
              <span className="absolute -bottom-1 left-0 h-px w-full origin-left scale-x-0 bg-accent-gradient transition-transform duration-300 ease-premium group-hover:scale-x-100" aria-hidden />
            </Link>
          ))}
        </div>

        <WalletButton />
      </nav>
    </motion.header>
  );
}
