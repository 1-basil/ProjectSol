import Link from "next/link";
import { Navbar } from "./Navbar";
import { Footer } from "./Footer";

export function LegalPageShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main>
      <Navbar />
      <div className="mx-auto max-w-2xl px-6 pb-28 pt-40">
        <Link href="/" className="focus-ring text-[13px] text-ink-muted transition-colors hover:text-ink">
          ← Back to ProjectSol
        </Link>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">{title}</h1>
        <div className="mt-8 space-y-4 text-[14px] leading-relaxed text-ink-muted">{children}</div>
      </div>
      <Footer />
    </main>
  );
}
