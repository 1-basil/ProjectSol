"use client";

import { Navbar } from "../../components/landing/Navbar";
import { AppExperience } from "../../components/app/AppExperience";

export default function AppPage() {
  return (
    <>
      <Navbar />
      <main className="min-h-screen pt-24">
        <AppExperience />
      </main>
    </>
  );
}
