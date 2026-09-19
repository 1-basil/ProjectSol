import { Navbar } from "../components/landing/Navbar";
import { Hero } from "../components/landing/Hero";
import { CoinMarquee } from "../components/landing/CoinMarquee";
import { TrustStrip } from "../components/landing/TrustStrip";
import { HowItWorks } from "../components/landing/HowItWorks";
import { AssetManagement } from "../components/landing/AssetManagement";
import { Automation } from "../components/landing/Automation";
import { Transparency } from "../components/landing/Transparency";
import { SecurityArchitecture } from "../components/landing/SecurityArchitecture";
import { UserControl } from "../components/landing/UserControl";
import { FinalCta } from "../components/landing/FinalCta";
import { Footer } from "../components/landing/Footer";

export default function LandingPage() {
  return (
    <main>
      <Navbar />
      <Hero />
      <CoinMarquee />
      <TrustStrip />
      <HowItWorks />
      <AssetManagement />
      <Automation />
      <Transparency />
      <SecurityArchitecture />
      <UserControl />
      <FinalCta />
      <Footer />
    </main>
  );
}
