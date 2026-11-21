import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2.5 mb-3">
      <Link href={href}>
        <ArrowLeft />
        {label}
      </Link>
    </Button>
  );
}
