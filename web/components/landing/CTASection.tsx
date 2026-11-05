import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';
import { PRICE_LINE } from '@/lib/product-facts';

export function CTASection() {
  return (
    <section className="py-20 sm:py-32 px-4 sm:px-6 relative overflow-hidden">

      <div className="relative z-10 max-w-2xl mx-auto text-center">
        <p className="text-sm text-accent-warm font-medium mb-4 tracking-wider uppercase">
          {PRICE_LINE}
        </p>

        <h2 className="section-headline text-foreground mb-8">
          ready to take control?
        </h2>

        <Button
          asChild
          size="lg"
          className="text-background font-semibold px-10 h-14 text-lg group"
        >
          <Link href="/register" className="flex items-center gap-2">
            get started
            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
          </Link>
        </Button>
      </div>
    </section>
  );
}
