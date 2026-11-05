"use client";

import { use, useId, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";

/**
 * Mermaid diagrams, themed with the docs' own tokens so they read as part of
 * the page. `remarkMdxMermaid` (source.config.ts) rewrites every ```mermaid
 * fence into `<Mermaid chart="..." />`, so this owns all diagram rendering.
 * Mermaid loads lazily via a module-level promise cache; rendered SVG is
 * cached per chart+theme.
 *
 * Theme tokens are read live at render time, then normalized to hex through a
 * canvas 2d context — they are `oklch(...)`, which Mermaid's khroma cannot
 * parse.
 *
 * `fontFamily` must be explicit (never `inherit`) and `document.fonts.ready`
 * awaited: Mermaid sizes nodes by measuring text, so a measure/render font
 * mismatch makes boxes a glyph too narrow and clips the last character.
 */
const subscribe = () => () => {};

function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

export function Mermaid({ chart }: { chart: string }) {
  if (!useIsClient()) return null;
  return <MermaidContent chart={chart} />;
}

const cache = new Map<string, Promise<unknown>>();

function cachePromise<T>(key: string, setPromise: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached as Promise<T>;

  const promise = setPromise();
  cache.set(key, promise);
  return promise;
}

/** a token that fails to resolve falls back to a hex from the theme being drawn */
const FALLBACKS = {
  dark: {
    background: "#0b1020",
    foreground: "#f7f8f8",
    card: "#1c2333",
    border: "#3a4663",
    muted: "#262f44",
    mutedForeground: "#9aa6c0",
    accent: "#36c5d6",
    accentMuted: "#2a6e78",
  },
  light: {
    background: "#f4f7fb",
    foreground: "#101926",
    card: "#fcfdff",
    border: "#d0d9e2",
    muted: "#eaeff5",
    mutedForeground: "#4f5c6d",
    accent: "#007691",
    accentMuted: "#91c9d4",
  },
};

/**
 * Design tokens → hex colors + font stack. Reads the docs layout element so it
 * inherits the active theme's cascade, falling back to <html> then `fallback`.
 */
function resolveTokens(fallback: (typeof FALLBACKS)["dark"]) {
  const root = document.getElementById("nd-docs-layout") ?? document.documentElement;
  const cs = getComputedStyle(root);
  const ctx = document.createElement("canvas").getContext("2d", {
    willReadFrequently: true,
  });

  // Rasterize to one sRGB pixel and read the bytes. `ctx.fillStyle` is no good:
  // for oklch/wide-gamut input the canvas echoes `lab(...)`/`color(...)`, which
  // khroma rejects. Drawing forces a concrete sRGB value.
  const hex = (value: string, fallback: string): string => {
    const v = value.trim();
    if (!v || !ctx) return fallback;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000000";
    try {
      ctx.fillStyle = v;
    } catch {
      return fallback;
    }
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  };
  const color = (name: string, fallback: string) =>
    hex(cs.getPropertyValue(name), fallback);

  const fontGeist = cs.getPropertyValue("--font-geist").trim();
  return {
    background: color("--background", fallback.background),
    foreground: color("--foreground", fallback.foreground),
    card: color("--card", fallback.card),
    border: color("--border", fallback.border),
    muted: color("--muted", fallback.muted),
    mutedForeground: color("--muted-foreground", fallback.mutedForeground),
    accent: color("--accent-cyan", fallback.accent),
    accentMuted: color("--accent-cyan-muted", fallback.accentMuted),
    fontFamily: `${fontGeist ? `${fontGeist}, ` : ""}ui-sans-serif, system-ui, sans-serif`,
  };
}

function MermaidContent({ chart }: { chart: string }) {
  const id = useId();
  const { resolvedTheme } = useTheme();
  const { default: mermaid } = use(
    cachePromise("mermaid", () => import("mermaid")),
  );

  const { svg, bindFunctions } = use(
    cachePromise(`${chart}-${resolvedTheme}`, async () => {
      // Measure with the render font — see the clipping note above.
      if (document.fonts?.ready) await document.fonts.ready;
      const t = resolveTokens(FALLBACKS[resolvedTheme === "light" ? "light" : "dark"]);

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        theme: "base",
        fontFamily: t.fontFamily,
        themeCSS: "margin: 1.25rem auto 0;",
        // Extra rank spacing stops antiparallel edge labels (RUNNING<->KILLED)
        // overlapping.
        flowchart: { curve: "basis", nodeSpacing: 60, rankSpacing: 80 },
        themeVariables: {
          darkMode: resolvedTheme !== "light",
          fontFamily: t.fontFamily,
          fontSize: "15px",
          background: t.background,
          // shared node palette (flowchart + state)
          primaryColor: t.card,
          primaryBorderColor: t.border,
          primaryTextColor: t.foreground,
          secondaryColor: t.muted,
          tertiaryColor: t.background,
          mainBkg: t.card,
          nodeBorder: t.border,
          nodeTextColor: t.foreground,
          clusterBkg: t.muted,
          clusterBorder: t.border,
          lineColor: t.mutedForeground,
          textColor: t.foreground,
          titleColor: t.foreground,
          edgeLabelBackground: t.background,
          // state diagram specifics
          labelColor: t.foreground,
          // sequence diagram specifics
          actorBkg: t.card,
          actorBorder: t.border,
          actorTextColor: t.foreground,
          actorLineColor: t.border,
          signalColor: t.mutedForeground,
          signalTextColor: t.foreground,
          labelBoxBkgColor: t.card,
          labelBoxBorderColor: t.border,
          labelTextColor: t.foreground,
          loopTextColor: t.foreground,
          noteBkgColor: t.muted,
          noteTextColor: t.foreground,
          noteBorderColor: t.border,
          activationBkgColor: t.muted,
          activationBorderColor: t.border,
          sequenceNumberColor: t.background,
        },
      });

      // useId() yields ":r0:"; mermaid passes the id to querySelector, where a
      // leading colon throws.
      return mermaid.render(id.replaceAll(":", ""), chart.replaceAll("\\n", "\n"));
    }),
  );

  return (
    <div
      ref={(container) => {
        if (container) bindFunctions?.(container);
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
