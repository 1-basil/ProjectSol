import { LegalPageShell } from "../../components/landing/LegalPageShell";

export default function TermsPage() {
  return (
    <LegalPageShell title="Terms & Conditions">
      <p className="rounded-xl border border-warning/20 bg-warning/10 p-4 text-warning">
        This page is a placeholder. ProjectSol&apos;s full Terms &amp; Conditions have not yet been published. No legally binding terms are
        presented here — do not rely on this page for legal purposes.
      </p>
      <p>When published, this page will describe the actual terms governing use of ProjectSol, including the scope of the authorization you grant, applicable fees, and the limits of ProjectSol&apos;s responsibilities.</p>
      <p>Until then, refer only to the authorization details shown to you directly in the product before you sign any transaction.</p>
    </LegalPageShell>
  );
}
