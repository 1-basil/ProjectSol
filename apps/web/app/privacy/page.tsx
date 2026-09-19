import { LegalPageShell } from "../../components/landing/LegalPageShell";

export default function PrivacyPage() {
  return (
    <LegalPageShell title="Privacy Policy">
      <p className="rounded-xl border border-warning/20 bg-warning/10 p-4 text-warning">
        This page is a placeholder. ProjectSol&apos;s full Privacy Policy has not yet been published.
      </p>
      <p>ProjectSol&apos;s interface reads publicly available on-chain data associated with the wallet address you connect. It never requests, stores, or transmits a seed phrase or private key.</p>
      <p>A complete privacy policy describing what data is collected and how it is used will be published here before general availability.</p>
    </LegalPageShell>
  );
}
