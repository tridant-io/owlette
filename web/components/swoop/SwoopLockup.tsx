import Image from 'next/image';
import { cn } from '@/lib/utils';

/**
 * owlette swoop's own mark: the small eye its app icon carries, where owlette's
 * mark is the full eye (`OwletteEyeIcon`). the same pixels as the app's icon
 * (`desktop/src-tauri/icons`, which desktop/viewer's tauri.conf.json points
 * at), so the window, the taskbar and the page show one logo.
 */
export function SwoopLogo({ size, className }: { size: number; className?: string }) {
  return (
    <Image
      src="/owlette-swoop-icon.png"
      alt=""
      aria-hidden
      width={size}
      height={size}
      className={cn('shrink-0', className)}
    />
  );
}

/** "owlette swoop", one name in one weight and one size. */
export function SwoopLockup({ size = 'sm', className }: { size?: 'sm' | 'lg'; className?: string }) {
  return (
    <span
      data-testid="swoop-lockup"
      className={cn('whitespace-nowrap font-semibold text-foreground', size === 'sm' && 'text-base', className)}
    >
      owlette swoop
    </span>
  );
}
