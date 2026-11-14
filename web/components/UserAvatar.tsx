'use client';

import type { User } from 'firebase/auth';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { getUserInitials } from '@/lib/userUtils';
import { cn } from '@/lib/utils';

type Size = 'sm' | 'md' | 'lg';

interface UserAvatarProps {
  user: User | null;
  size?: Size;
  className?: string;
  /**
   * Optional override for the image src. When provided, takes precedence over user.photoURL.
   * Useful for showing a local preview (e.g. a newly-cropped image) before upload completes.
   */
  previewUrl?: string | null;
}

const SIZE_CLASSES: Record<Size, string> = {
  sm: 'h-7 w-7 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-24 w-24 text-xl',
};

export function UserAvatar({ user, size = 'sm', className, previewUrl }: UserAvatarProps) {
  const src = previewUrl ?? user?.photoURL ?? undefined;
  const initials = user ? getUserInitials(user) : '?';

  return (
    <Avatar className={cn(SIZE_CLASSES[size], className)}>
      {src && <AvatarImage src={src} alt={user?.displayName || user?.email || 'User avatar'} />}
      <AvatarFallback className="bg-accent-cyan text-primary-foreground font-medium">
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}
