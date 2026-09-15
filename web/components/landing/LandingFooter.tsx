import Link from 'next/link';
import { OwletteEyeIcon } from './OwletteEye';
import { TridantSystem } from '../TridantSystem';
import { LICENSE_URL } from '@/lib/repoLinks';

const RANDOM_EMOJIS = [
"❤️", "💙", "💚", "💛", "💜", "🧡",
"✨", "🌟", "⭐", "💫", "🌈",
"🔥", "⚡", "💥", "🚀",
"🎨", "🎭", "🎪", "🎯",
"🦉", "🦆", "🐧", "🦜",
"☕", "🍕", "🌮", "🍔",
"🎵", "🎸", "🎹", "🎤",
"💻", "🖥️", "⌨️", "🖱️",
"🎲", "🎮", "🕹️",
"🌙", "☀️", "⛅", "🌤️",
];

function Dot() {
  return <span aria-hidden="true" className="text-muted-foreground/50">&middot;</span>;
}

export function LandingFooter() {
  // Server Component — Math.random() runs once per server render and is serialized
  // into HTML. No hydration mismatch is possible (the client never re-runs this).
  // eslint-disable-next-line react-hooks/purity
  const emoji = RANDOM_EMOJIS[Math.floor(Math.random() * RANDOM_EMOJIS.length)];

  return (
    <footer className="border-t border-border/50 bg-card/30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <div className="flex flex-col items-center gap-8 sm:gap-10 text-center">
          {/* Brand line — the anchor: larger, brighter wordmark */}
          <div className="flex flex-wrap items-center justify-center gap-x-3.5 gap-y-2 text-sm text-muted-foreground">
            <Link href="/" className="flex items-center gap-2 text-base font-semibold text-foreground hover:text-foreground/80 transition-colors">
              <OwletteEyeIcon size={22} className="translate-y-[1px]" />
              <span className="translate-y-[1px]">owlette</span>
            </Link>
            <Dot />
            <TridantSystem />
            <Dot />
            <span>&copy; 2026</span>
          </div>

          {/* Utility group — nav + fine print kept close together, set apart from the brand line */}
          <div className="flex flex-col items-center gap-2 sm:gap-2.5">
            {/* Nav line — mid tier */}
            <nav className="flex flex-wrap items-center justify-center gap-x-6 sm:gap-x-7 gap-y-2 text-sm text-muted-foreground">
              <Link href="/docs" className="hover:text-foreground transition-colors">docs</Link>
              <Link href="/privacy" className="hover:text-foreground transition-colors">privacy policy</Link>
              <Link href="/terms" className="hover:text-foreground transition-colors">terms of service</Link>
              <a href="mailto:support@tridant.io" className="hover:text-foreground transition-colors">contact</a>
              <Link href="/for-ai" className="hover:text-foreground transition-colors">for AI</Link>
            </nav>

            {/* Credits / license line — quietest tier */}
            <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1.5 text-xs text-muted-foreground/55">
              <span className="flex items-center gap-1.5">
                made with
                <span className="text-sm leading-none">{emoji}</span>
                in california
              </span>
              <Dot />
              <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">
                FSL-1.1-Apache-2.0
              </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
