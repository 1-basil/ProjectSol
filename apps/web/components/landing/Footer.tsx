import Link from "next/link";
import { Wordmark } from "../ui/Wordmark";

const LINKS = [
  { label: "Product", href: "#product" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Security", href: "#security" },
  { label: "Terms", href: "/terms" },
  { label: "Privacy", href: "/privacy" },
  { label: "Documentation", href: "/docs" },
];

export function Footer() {
  return (
    <footer className="border-t border-white/10 bg-black px-6 py-14">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 sm:flex-row">
        <Wordmark className="text-base" />
        <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
          {LINKS.map((link) => (
            <Link key={link.label} href={link.href} className="focus-ring rounded-md text-[13px] text-ink-muted transition-colors hover:text-ink">
              {link.label}
            </Link>
          ))}
        </nav>
        <p className="text-[12px] text-ink-faint">© {new Date().getFullYear()} ProjectSol</p>
      </div>
    </footer>
  );
}
