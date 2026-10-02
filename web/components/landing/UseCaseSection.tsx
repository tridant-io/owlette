'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ChevronDown, ChevronLeft, ChevronRight, Monitor, Power, Rocket, X, Zap } from 'lucide-react';
import Image from 'next/image';
import { HootIcon } from '@/components/icons/HootIcon';

// React.ElementType rather than lucide's LucideIcon: the hoot card uses the
// custom HootIcon (a plain SVG component, not a lucide forwardRef export).
const capabilities: { label: string; detail: string; expanded: string; preview: string; icon: React.ElementType }[] = [
  {
    label: 'monitor',
    detail: 'real-time metrics and email/webhook notifications',
    expanded: 'live cpu, memory, gpu, and disk usage for every machine. inline sparkline charts track trends over time. know instantly when something drifts.',
    preview: '/landing-screens/monitor.png',
    icon: Activity,
  },
  {
    label: 'control',
    detail: 'start, stop, or restart any process — with a full API',
    expanded: 'full remote process control across your entire fleet. configure startup sequences, manage dependencies, and auto-restart crashed processes before anyone notices.',
    preview: '/landing-screens/control.png',
    icon: Power,
  },
  {
    label: 'deploy',
    detail: 'push software updates to all machines at once',
    expanded: 'deploy software, configurations, and content to any machine, anywhere. fleet-wide rollouts or targeted single-machine updates — your call.',
    preview: '/landing-screens/preview-deploy.png',
    icon: Rocket,
  },
  {
    label: 'diagnose',
    detail: 'ask hoot why a process crashed, what driver is installed, or which machine just dropped offline.',
    expanded: 'hoot turns plain-english questions into real diagnostic actions across your fleet. bring your own openai or anthropic key.',
    preview: '/landing-screens/preview-diagnose.png',
    icon: HootIcon,
  },
  {
    label: 'display',
    detail: 'displays that stay put — drift-detected and auto-restored after restarts, driver updates, or accidental changes.',
    expanded: 'owlette captures the windows display topology you want and watches for drift. when a restart, a driver update, or an accidental change moves a monitor, owlette restores the known-good layout automatically. mosaic-aware.',
    preview: '/landing-screens/preview-displays.png',
    icon: Monitor,
  },
  {
    label: 'automate',
    detail: 'talons fire on a schedule, a threshold, or an event — and can look at the screen before acting.',
    expanded: 'every talon is a trigger, an optional condition, and outputs. fire on a schedule, a metric threshold, or an event like a crash. gate it on an ai visual check of a fresh screenshot. then email, post a webhook, restart the process, or hand hoot a directive.',
    preview: '/landing-screens/preview-automate.png',
    icon: Zap,
  },
];

export function UseCaseSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Mirror dragRef.current.dragging as state for the transition toggle in
  // render — React 19 forbids reading ref.current during render. The state
  // only flips on drag start/end (not per-mousemove) so it's cheap.
  const [isDragging, setIsDragging] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ dragging: boolean; didDrag: boolean; startX: number; startY: number; startPanX: number; startPanY: number }>({
    dragging: false, didDrag: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0,
  });
  const touchRef = useRef<{ startDist: number; startScale: number; startX: number; startY: number; startPanX: number; startPanY: number; didInteract: boolean }>({
    startDist: 0, startScale: 1, startX: 0, startY: 0, startPanX: 0, startPanY: 0, didInteract: false,
  });
  const isZoomed = scale > 1;
  const lightboxOpen = lightboxIndex !== null;
  const lightboxSrc = lightboxOpen ? capabilities[lightboxIndex].preview : null;

  // Matches the expanded-panel collapse transition (duration-500) + a small buffer.
  const COLLAPSE_MS = 520;

  const toggle = (i: number, el: HTMLElement | null) => {
    if (openIndex === i) {
      setOpenIndex(null);
      return;
    }
    // If a card above this one is open, its panel must finish collapsing before
    // the layout above settles — wait for that, otherwise anchor immediately.
    // (block: 'start' honours the global scroll-padding-top, so it clears the header.)
    const delay = openIndex !== null && openIndex < i ? COLLAPSE_MS : 0;
    setOpenIndex(i);
    if (!el) return;
    setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), delay);
  };

  const closeLightbox = useCallback(() => {
    const shown = lightboxIndex === null ? null : capabilities[lightboxIndex].label;
    setLightboxIndex(null);
    setScale(1);
    setPan({ x: 0, y: 0 });
    dragRef.current = { dragging: false, didDrag: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0 };
    // focus goes back to the preview of what was shown last, not the opener:
    // paging the lightbox moves the open card along, and the opener's panel
    // may have collapsed. the accordion and the grid both carry one, and only
    // the one this breakpoint lays out has client rects.
    const triggers = Array.from(
      sectionRef.current?.querySelectorAll<HTMLElement>(`[data-preview-trigger="${shown}"]`) ?? [],
    );
    (triggers.find((el) => el.getClientRects().length > 0) ?? triggers[0])?.focus();
  }, [lightboxIndex]);

  useEffect(() => {
    if (lightboxOpen) closeButtonRef.current?.focus();
  }, [lightboxOpen]);

  const goTo = useCallback((index: number) => {
    setLightboxIndex(index);
    setOpenIndex(index);
    setScale(1);
    setPan({ x: 0, y: 0 });
    dragRef.current = { dragging: false, didDrag: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0 };
  }, []);

  useEffect(() => {
    if (!lightboxOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightbox();
      // aria-modal says the page behind is out of reach, so tab wraps in here.
      if (e.key === 'Tab' && overlayRef.current) {
        const buttons = overlayRef.current.querySelectorAll<HTMLElement>('button');
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        const active = document.activeElement;
        if (!overlayRef.current.contains(active) || active === (e.shiftKey ? first : last)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        setLightboxIndex((prev) => {
          if (prev === null) return null;
          const next = (prev + 1) % capabilities.length;
          setOpenIndex(next);
          return next;
        });
        setScale(1);
        setPan({ x: 0, y: 0 });
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        setLightboxIndex((prev) => {
          if (prev === null) return null;
          const next = (prev - 1 + capabilities.length) % capabilities.length;
          setOpenIndex(next);
          return next;
        });
        setScale(1);
        setPan({ x: 0, y: 0 });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightboxOpen, closeLightbox]);

  // Scroll wheel zoom — block page scroll while lightbox is open
  useEffect(() => {
    if (!lightboxOpen) return;
    const el = overlayRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      setScale((prev) => {
        const next = Math.max(1, Math.min(prev + delta * prev, 10));
        if (next === 1) setPan({ x: 0, y: 0 });
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [lightboxOpen]);

  // Touch: pinch-to-zoom + single-finger pan
  useEffect(() => {
    if (!lightboxOpen) return;
    const el = overlayRef.current;
    if (!el) return;

    const dist = (a: Touch, b: Touch) =>
      Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const d = dist(e.touches[0], e.touches[1]);
        touchRef.current = { startDist: d, startScale: scale, startX: 0, startY: 0, startPanX: pan.x, startPanY: pan.y, didInteract: false };
      } else if (e.touches.length === 1 && scale > 1) {
        e.preventDefault();
        touchRef.current = { startDist: 0, startScale: scale, startX: e.touches[0].clientX, startY: e.touches[0].clientY, startPanX: pan.x, startPanY: pan.y, didInteract: false };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const d = dist(e.touches[0], e.touches[1]);
        const newScale = Math.max(1, Math.min(touchRef.current.startScale * (d / touchRef.current.startDist), 10));
        touchRef.current.didInteract = true;
        setScale(newScale);
        if (newScale === 1) setPan({ x: 0, y: 0 });
      } else if (e.touches.length === 1 && scale > 1) {
        e.preventDefault();
        const dx = e.touches[0].clientX - touchRef.current.startX;
        const dy = e.touches[0].clientY - touchRef.current.startY;
        touchRef.current.didInteract = true;
        setPan({ x: touchRef.current.startPanX + dx, y: touchRef.current.startPanY + dy });
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, [lightboxOpen, scale, pan]);

  const activePreview = openIndex !== null ? capabilities[openIndex].preview : undefined;

  return (
    <section ref={sectionRef} id="capabilities" className="pt-24 sm:pt-32 pb-20 sm:pb-32 px-4 sm:px-6 relative -scroll-mt-16 sm:-scroll-mt-24">
      <div className="max-w-5xl mx-auto relative">

        {/* Mobile: single-column accordion — each card owns its expanded content */}
        <div className="flex flex-col gap-2 lg:hidden">
          {capabilities.map((cap, i) => (
            <div key={cap.label}>
              <button
                onClick={(e) => toggle(i, e.currentTarget)}
                className={`w-full text-center group cursor-pointer rounded-lg p-4 transition-all duration-300 border ${openIndex === i ? 'bg-card/60 border-border' : 'border-transparent hover:bg-card/50'}`}
              >
                <cap.icon className={`w-8 h-8 mx-auto mb-3 transition-colors ${openIndex === i ? 'text-accent-cyan' : 'text-muted-foreground group-hover:text-accent-cyan'}`} />
                <div className="flex items-center justify-center gap-1.5 mb-2">
                  <h3 className={`text-xl font-bold font-heading transition-colors ${openIndex === i ? 'text-accent-cyan' : 'text-foreground group-hover:text-accent-cyan'}`}>
                    {cap.label}
                  </h3>
                  <ChevronDown
                    className={`w-4 h-4 text-muted-foreground transition-transform duration-300 ${openIndex === i ? 'rotate-180' : ''}`}
                  />
                </div>
                <p className="text-base text-muted-foreground">
                  {cap.detail}
                </p>
              </button>

              {/* Expanded content inline below the card */}
              <div
                aria-hidden={openIndex !== i}
                className={`overflow-hidden transition-all duration-500 ease-out ${openIndex === i ? 'max-h-[800px] opacity-100' : 'max-h-0 opacity-0'}`}
              >
                <p className="text-base text-foreground/80 leading-loose text-center px-6 pb-4 animate-in fade-in duration-300">
                  {cap.expanded}
                </p>
                <div className="px-2 pb-4">
                  <button
                    type="button"
                    aria-label={`open ${cap.label} preview`}
                    data-preview-trigger={cap.label}
                    tabIndex={openIndex === i ? 0 : -1}
                    className="block w-full relative rounded-xl overflow-hidden shadow-2xl shadow-black/30 ring-1 ring-white/5 cursor-zoom-in border-0 bg-transparent p-0"
                    style={{
                      maskImage: 'linear-gradient(to bottom, black 80%, transparent)',
                      WebkitMaskImage: 'linear-gradient(to bottom, black 80%, transparent)',
                    }}
                    onClick={() => setLightboxIndex(i)}
                  >
                    <Image
                      src={cap.preview}
                      alt={`${cap.label} preview`}
                      width={1280}
                      height={720}
                      sizes="100vw"
                      className="w-full h-auto"
                    />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Desktop: two 3-column rows; the preview slides in below whichever
            row contains the active card so users don't have to look past
            unrelated cards to see the screenshot. */}
        <div className="hidden lg:block">
          {[0, 1].map((rowIdx) => {
            const rowStart = rowIdx * 3;
            const rowCaps = capabilities.slice(rowStart, rowStart + 3);
            const rowHasActive = openIndex !== null && openIndex >= rowStart && openIndex < rowStart + 3;
            const rowSpacing = rowIdx === 0 ? '' : 'mt-6';
            return (
              <div key={rowIdx} className={rowSpacing}>
                <div className="grid grid-cols-3 gap-6 items-start">
                  {rowCaps.map((cap, sliceIdx) => {
                    const i = rowStart + sliceIdx;
                    return (
                      <button
                        key={cap.label}
                        onClick={(e) => toggle(i, e.currentTarget)}
                        className={`text-center group cursor-pointer rounded-lg p-4 transition-all duration-300 border ${openIndex === i ? 'bg-card/60 border-border' : 'border-transparent hover:bg-card/50'}`}
                      >
                        <cap.icon className={`w-8 h-8 mx-auto mb-3 transition-colors ${openIndex === i ? 'text-accent-cyan' : 'text-muted-foreground group-hover:text-accent-cyan'}`} />
                        <div className="flex items-center justify-center gap-1.5 mb-2">
                          <h3 className={`text-2xl font-bold font-heading transition-colors ${openIndex === i ? 'text-accent-cyan' : 'text-foreground group-hover:text-accent-cyan'}`}>
                            {cap.label}
                          </h3>
                          <ChevronDown
                            className={`w-4 h-4 text-muted-foreground transition-transform duration-300 ${openIndex === i ? 'rotate-180' : ''}`}
                          />
                        </div>
                        <p className="text-base text-muted-foreground">
                          {cap.detail}
                        </p>
                      </button>
                    );
                  })}
                </div>

                {/* Expanded text — mirrors this row's column for the active card */}
                {rowHasActive && (
                  <div className="grid grid-cols-3 gap-6 mt-2">
                    {rowCaps.map((cap, sliceIdx) => {
                      const i = rowStart + sliceIdx;
                      return (
                        <div key={cap.label} className={i === openIndex ? 'animate-in fade-in duration-300' : ''}>
                          {i === openIndex && (
                            <p className="text-base text-foreground/80 leading-loose text-center px-2">
                              {cap.expanded}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Preview image — slides down below this row when its card is active */}
                <div
                  aria-hidden={!rowHasActive}
                  className={`overflow-hidden transition-all duration-500 ease-out ${rowHasActive ? 'max-h-[800px] opacity-100 mt-8' : 'max-h-0 opacity-0 mt-0'}`}
                >
                  <button
                    type="button"
                    aria-label={openIndex !== null ? `open ${capabilities[openIndex].label} preview` : 'open capability preview'}
                    data-preview-trigger={rowHasActive && openIndex !== null ? capabilities[openIndex].label : undefined}
                    tabIndex={rowHasActive ? 0 : -1}
                    className="block w-full relative rounded-xl overflow-hidden shadow-2xl shadow-black/30 ring-1 ring-white/5 cursor-zoom-in border-0 bg-transparent p-0"
                    style={{
                      maskImage: 'linear-gradient(to bottom, black 80%, transparent), linear-gradient(to right, transparent, black 25px, black calc(100% - 25px), transparent)',
                      maskComposite: 'intersect',
                      WebkitMaskImage: 'linear-gradient(to bottom, black 80%, transparent), linear-gradient(to right, transparent, black 25px, black calc(100% - 25px), transparent)',
                      WebkitMaskComposite: 'source-in',
                    }}
                    onClick={() => openIndex !== null && setLightboxIndex(openIndex)}
                  >
                    <div className="relative">
                      {rowCaps.map((cap) => (
                        <div
                          key={cap.preview}
                          className="transition-all duration-500 ease-out"
                          style={{
                            opacity: rowHasActive && activePreview === cap.preview ? 1 : 0,
                            position: rowHasActive && activePreview === cap.preview ? 'relative' : 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: rowHasActive && activePreview === cap.preview ? 'translateY(0)' : 'translateY(12px)',
                          }}
                        >
                          <Image
                            src={cap.preview}
                            alt={`${cap.label} preview`}
                            width={1280}
                            height={720}
                            // max-w-5xl inside px-6: 1024px from a 1072px viewport.
                            sizes="(max-width: 1072px) 100vw, 1024px"
                            className="w-full h-auto"
                          />
                        </div>
                      ))}
                    </div>
                  </button>
                </div>
              </div>
            );
          })}
        </div>

      </div>

      {/* Lightbox overlay */}
      {lightboxOpen && lightboxSrc && (
        <div
          ref={overlayRef}
          role="dialog"
          aria-modal="true"
          aria-label={`${capabilities[lightboxIndex].label} preview`}
          className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center overflow-hidden touch-none animate-in fade-in duration-200"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeLightbox();
          }}
          onMouseDown={(e) => {
            if (!isZoomed) return;
            e.preventDefault();
            dragRef.current = { dragging: true, didDrag: false, startX: e.clientX, startY: e.clientY, startPanX: pan.x, startPanY: pan.y };
            setIsDragging(true);
          }}
          onMouseMove={(e) => {
            if (!dragRef.current.dragging) return;
            const dx = e.clientX - dragRef.current.startX;
            const dy = e.clientY - dragRef.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragRef.current.didDrag = true;
            setPan({ x: dragRef.current.startPanX + dx, y: dragRef.current.startPanY + dy });
          }}
          onMouseUp={() => { dragRef.current.dragging = false; setIsDragging(false); }}
          onMouseLeave={() => { dragRef.current.dragging = false; setIsDragging(false); }}
        >
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="close preview"
            onClick={closeLightbox}
            className="absolute top-4 right-4 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
          >
            <X className="w-6 h-6 text-white" />
          </button>

          {/* Prev / Next arrows */}
          <button
            type="button"
            aria-label="previous preview"
            onClick={(e) => { e.stopPropagation(); goTo((lightboxIndex - 1 + capabilities.length) % capabilities.length); }}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
          >
            <ChevronLeft className="w-6 h-6 text-white" />
          </button>
          <button
            type="button"
            aria-label="next preview"
            onClick={(e) => { e.stopPropagation(); goTo((lightboxIndex + 1) % capabilities.length); }}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
          >
            <ChevronRight className="w-6 h-6 text-white" />
          </button>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={lightboxSrc}
            alt={`${capabilities[lightboxIndex].label} preview`}
            draggable={false}
            className={`select-none max-w-[95vw] max-h-[95vh] object-contain ${
              isZoomed
                ? 'cursor-grab active:cursor-grabbing'
                : 'cursor-zoom-in animate-in zoom-in-95 duration-200'
            }`}
            style={{
              transformOrigin: 'center center',
              transition: isDragging ? 'none' : 'transform 0.2s ease-out',
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (dragRef.current.didDrag) return;
              if (!isZoomed && imgRef.current) {
                setScale(imgRef.current.naturalWidth / imgRef.current.clientWidth);
                setPan({ x: 0, y: 0 });
              } else {
                setScale(1);
                setPan({ x: 0, y: 0 });
              }
            }}
          />

          {/* Caption under image */}
          <p className="absolute bottom-14 left-1/2 -translate-x-1/2 z-10 text-lg text-white/70 text-center text-balance max-w-2xl mx-auto px-4">
            {capabilities[lightboxIndex].detail}
          </p>

          {/* Dot indicators */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 flex gap-2">
            {capabilities.map((cap, i) => (
              <button
                key={cap.label}
                type="button"
                aria-label={`show ${cap.label} preview`}
                aria-current={i === lightboxIndex ? 'true' : undefined}
                onClick={(e) => { e.stopPropagation(); goTo(i); }}
                className={`w-2 h-2 rounded-full transition-all cursor-pointer ${
                  i === lightboxIndex ? 'bg-accent-cyan w-6' : 'bg-white/30 hover:bg-white/50'
                }`}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
