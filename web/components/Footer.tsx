"use client";

import Link from "next/link";
import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { GITHUB_REPO_URL } from "@/lib/repoLinks";

const RANDOM_EMOJIS = [
"❤️", "💙", "💚", "💛", "💜", "🧡", // hearts
"✨", "🌟", "⭐", "💫", "🌈", // sparkles
"🔥", "⚡", "💥", "🚀", // energy
"🎨", "🎭", "🎪", "🎯", // creative
"🦉", "🦆", "🐧", "🦜", // birds (owlette!)
"☕", "🍕", "🌮", "🍔", // food
"🎵", "🎸", "🎹", "🎤", // music
"💻", "🖥️", "⌨️", "🖱️", // tech
"🎲", "🎮", "🕹️", // games
"🌙", "☀️", "⛅", "🌤️", // weather
"🤪", "😜", "😝", "🥴", "😵‍💫", "🤡", "🥳", "😎", // goofy faces
"💨", "🌪️", "💩", "🧻", // wind/farts
"🦄", "🦖", "🦕", "🐙", "🦑", "🦞", // silly animals
"🍌", "🥒", "🌽", "🍆", "🥑", "🧀", // funny food
"🎃", "👻", "💀", "👽", "🤖", "🛸", // spooky/weird
"🦷", "👀", "👁️", "🧠", "🦴", // body parts (weird!)
"💯", "🆒", "🤙", "🤘", "✌️", "🫰", // gestures
"🪐", "🌮", "🦥", "🐢", "🐌", // random fun
];

export function Footer() {
  const pathname = usePathname();
  // Deterministically pick an emoji from the pathname so SSR and client render
  // the same glyph (no hydration mismatch) and the emoji changes per route.
  // The previous Math.random()-in-effect approach tripped
  // react-hooks/set-state-in-effect; a pure hash is simpler and identical in
  // spirit — every route gets its own emoji, same one every time.
  const emoji = useMemo(() => {
    const hash = Array.from(pathname || '').reduce(
      (h, c) => (h * 31 + c.charCodeAt(0)) | 0,
      0,
    );
    return RANDOM_EMOJIS[Math.abs(hash) % RANDOM_EMOJIS.length];
  }, [pathname]);

  // Hide footer on admin pages (admin panel has its own footer)
  // Hide footer on landing page (has its own LandingFooter)
  // Hide footer on /swoop — a live remote session is full-window, and the root
  // layout renders this as a sibling of the page, so its own layout cannot
  // remove it.
  if (
    pathname?.startsWith('/admin') ||
    pathname === '/' ||
    pathname?.startsWith('/hoot') ||
    pathname?.startsWith('/swoop')
  ) {
    return null;
  }

  return (
    <footer className="fixed bottom-0 left-0 right-0 w-full bg-gradient-to-t from-background via-background/95 to-transparent pt-8 pb-6 z-10 pointer-events-none">
      <div className="container mx-auto px-4 pointer-events-auto">
        <p className="text-center text-xs text-muted-foreground flex items-center justify-center gap-1">
          <span>made with</span>
          <span className="text-base leading-none -translate-y-0.4">{emoji}</span>
          <span>in california by</span>
          <Link
            href="https://tridant.io"
            target="_blank"
            rel="noopener noreferrer"
            className="hl-link hl-link-muted text-muted-foreground"
          >
            tridant
          </Link>
        </p>
        <p className="text-center text-xs text-muted-foreground mt-2 flex items-center justify-center gap-2">
          <Link
            href="/docs"
            className="hl-link hl-link-muted"
          >
            docs
          </Link>
          <span>&middot;</span>
          <Link
            href="/privacy"
            className="hl-link hl-link-muted"
          >
            privacy
          </Link>
          <span>&middot;</span>
          <Link
            href="/terms"
            className="hl-link hl-link-muted"
          >
            terms
          </Link>
          <span>&middot;</span>
          <Link
            href="/for-ai"
            className="hl-link hl-link-muted"
          >
            for AI
          </Link>
          <span>&middot;</span>
          <Link
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hl-link hl-link-muted"
          >
            source (FSL-1.1-Apache-2.0)
          </Link>
        </p>
      </div>
    </footer>
  );
}
