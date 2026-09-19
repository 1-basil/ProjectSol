import { LegalPageShell } from "../../components/landing/LegalPageShell";

export default function DocsPage() {
  return (
    <LegalPageShell title="Documentation">
      <p className="rounded-xl border border-border/10 bg-white/[0.03] p-4">
        Full developer and user documentation is not yet published. This page will describe the authorization flow, the fixed per-asset
        limits, and how to independently verify processed transfers on-chain.
      </p>
    </LegalPageShell>
  );
}
