import dynamic from 'next/dynamic';
import { headers } from 'next/headers';
import {
  LandingHeader,
  HeroSection,
  ValuePropSection,
  PricingSection,
  LandingFooter,
} from '@/components/landing';
import { PRODUCT_JSONLD } from '@/lib/product-facts';
import { landingDownloadPlatforms } from '@/lib/latestInstaller.server';
import { pickHeroHeadline } from '@/lib/heroHeadlines';

// Lazy-load below-fold sections to reduce initial JS bundle
// Note: ValuePropSection stays static because it contains the LCP image (dashboard.png)
const UseCaseSection = dynamic(() => import('@/components/landing/UseCaseSection').then(m => ({ default: m.UseCaseSection })));
const DisplaySection = dynamic(() => import('@/components/landing/DisplaySection').then(m => ({ default: m.DisplaySection })));
const DeveloperSection = dynamic(() => import('@/components/landing/DeveloperSection').then(m => ({ default: m.DeveloperSection })));
const FeatureGrid = dynamic(() => import('@/components/landing/FeatureGrid').then(m => ({ default: m.FeatureGrid })));
const ProofStrip = dynamic(() => import('@/components/landing/ProofStrip').then(m => ({ default: m.ProofStrip })));
const FAQSection = dynamic(() => import('@/components/landing/FAQSection').then(m => ({ default: m.FAQSection })));

// Landing-page structured data — single-sourced from lib/product-facts.ts so the
// markup, /llms.txt, /for-ai.json, and the /for-ai page can't drift apart.
const jsonLd = PRODUCT_JSONLD;

export default async function LandingPage() {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  // Rolled here rather than inside HeroSection: the hero is a client
  // component, so picking there would produce one phrase on the server and a
  // different one during hydration. Reading headers() above already opts this
  // page into per-request rendering, so the phrase re-rolls on every load
  // instead of freezing into a prerendered page.
  const heroHeadline = pickHeroHeadline();
  const downloadPlatforms = await landingDownloadPlatforms();

  return (
    <div className="min-h-screen relative">
      {/* suppressHydrationWarning: browsers blank the `nonce` content attribute
          once the element is inserted (the value moves to the `.nonce` IDL
          property, so CSS attribute selectors can't exfiltrate it). React's
          hydration diff reads the attribute, sees "", and reports a mismatch
          against the nonce it rendered — a false positive, since the browser
          has already applied the real value. */}
      <script
        nonce={nonce}
        type="application/ld+json"
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {/* Page-wide dot grid background */}
      <div className="fixed inset-0 dot-grid opacity-30 pointer-events-none" />
      <LandingHeader downloadPlatforms={downloadPlatforms} />
      <main>
        <HeroSection headline={heroHeadline} />
        <ValuePropSection />
        <UseCaseSection />
        <DisplaySection />
        <DeveloperSection />
        <FeatureGrid />
        <PricingSection />
        <ProofStrip />
        <FAQSection />
      </main>
      <LandingFooter />
    </div>
  );
}
