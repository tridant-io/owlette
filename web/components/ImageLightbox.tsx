'use client';

import { useRef } from 'react';
import { X as XIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';

interface ImageLightboxProps {
  /** the image to show; null keeps the lightbox closed */
  src: string | null;
  alt: string;
  onClose: () => void;
}

/** one image at full viewport, as a real modal: focus moves in, escape closes it,
 *  and focus goes back to the control that opened it. */
export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  // radix only returns focus to a DialogTrigger, and every opener here is a plain
  // button, so the opener is remembered by hand
  const openerRef = useRef<HTMLElement | null>(null);

  return (
    <Dialog open={src !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        aria-modal="true"
        aria-describedby={undefined}
        onOpenAutoFocus={() => {
          openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          openerRef.current?.focus();
        }}
        // the content covers the viewport, so radix never sees an outside click:
        // a click on the dark area around the image lands on the content itself
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 items-center justify-center rounded-none border-0 bg-black/90 p-0 shadow-none sm:max-w-none"
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        {/* no tooltip: radix focuses this on open, and an open tooltip would take the
            first escape press instead of the lightbox */}
        <IconButton
          label="close image"
          tooltip={false}
          variant="ghost"
          onClick={onClose}
          className="absolute top-4 right-4 text-white"
        >
          <XIcon className="size-6" />
        </IconButton>
        {src && (
          /* eslint-disable-next-line @next/next/no-img-element -- signed storage or blob url, not a static asset */
          <img src={src} alt={alt} className="max-h-[95dvh] max-w-[95vw] object-contain" />
        )}
      </DialogContent>
    </Dialog>
  );
}
