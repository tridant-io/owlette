'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ComponentProps } from 'react';

// Pre-wired admin button variants — eliminates verbose className strings throughout admin pages.
// Use these instead of raw <Button variant="outline" className="border-border bg-...">

const VARIANT_CLASSES = {
  outline: 'border-border bg-background text-foreground hover:bg-accent! hover:text-foreground!',
  card:    'border-border bg-card text-foreground hover:bg-accent! hover:text-foreground!',
  danger:  'border-border text-destructive hover:text-destructive!',
  primary: '',
} as const;

type AdminVariant = keyof typeof VARIANT_CLASSES;

type AdminButtonProps = Omit<ComponentProps<typeof Button>, 'variant'> & {
  adminVariant: AdminVariant;
};

export function AdminButton({ adminVariant, className, ...props }: AdminButtonProps) {
  const isDefault = adminVariant === 'primary';
  return (
    <Button
      variant={isDefault ? 'default' : 'outline'}
      className={cn(VARIANT_CLASSES[adminVariant], className)}
      {...props}
    />
  );
}
