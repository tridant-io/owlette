---
name: owlette
description: mission control for unattended machines
colors:
  signal-cyan: "oklch(0.75 0.18 195)"
  signal-cyan-bright: "oklch(0.80 0.20 195)"
  signal-cyan-dim: "oklch(0.45 0.10 195)"
  signal-cyan-ink: "oklch(0.15 0.02 195)"
  sodium-amber: "oklch(0.72 0.16 55)"
  sodium-amber-bright: "oklch(0.78 0.18 55)"
  sodium-amber-dim: "oklch(0.45 0.10 45)"
  console-navy: "oklch(0.145 0.03 250)"
  sunken-navy: "oklch(0.19 0.04 250)"
  popover-navy: "oklch(0.205 0.04 250)"
  panel-navy: "oklch(0.23 0.04 250)"
  input-navy: "oklch(0.25 0.06 250)"
  control-navy: "oklch(0.269 0.05 250)"
  hairline-blue: "oklch(0.35 0.08 250)"
  readout-white: "oklch(0.985 0.01 250)"
  muted-steel: "oklch(0.708 0.05 250)"
  alarm-coral: "oklch(0.704 0.191 22.216)"
  online-green: "oklch(0.723 0.219 149.579)"
  offline-red: "oklch(0.577 0.245 27.325)"
  warning-yellow: "oklch(0.795 0.184 86.047)"
  critical-red: "oklch(0.637 0.237 25.331)"
  band-calm-emerald: "rgb(16, 185, 129)"
  band-steady-violet: "rgb(139, 92, 246)"
  band-working-sky: "rgb(14, 165, 233)"
  band-strained-amber: "rgb(245, 158, 11)"
  band-critical-red: "rgb(239, 68, 68)"
typography:
  display:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.5rem, 5vw + 1rem, 4.5rem)"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  section:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.75rem, 3vw + 0.5rem, 2.5rem)"
    fontWeight: 600
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  control:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.43
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.33
  readout:
    fontFamily: "Geist Mono, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.33
  micro:
    fontFamily: "Geist Mono, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "0.625rem"
    fontWeight: 400
    letterSpacing: "0.05em"
rounded:
  sm: "2px"
  md: "4px"
  lg: "6px"
  xl: "10px"
  full: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
  "8": "32px"
components:
  button-primary:
    backgroundColor: "{colors.signal-cyan}"
    textColor: "{colors.signal-cyan-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-outline:
    backgroundColor: "{colors.input-navy}"
    textColor: "{colors.readout-white}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.control-navy}"
    textColor: "{colors.readout-white}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.readout-white}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-destructive:
    backgroundColor: "oklch(0.704 0.191 22.216 / 0.6)"
    textColor: "#ffffff"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  input:
    backgroundColor: "oklch(0.25 0.06 250 / 0.3)"
    textColor: "{colors.readout-white}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  card:
    backgroundColor: "{colors.panel-navy}"
    textColor: "{colors.readout-white}"
    rounded: "{rounded.xl}"
    padding: "24px"
  badge:
    backgroundColor: "{colors.signal-cyan}"
    textColor: "{colors.signal-cyan-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  status-offline:
    backgroundColor: "{colors.offline-red}"
    textColor: "#ffffff"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  menu-surface:
    backgroundColor: "oklch(0.269 0.05 250 / 0.85)"
    textColor: "{colors.readout-white}"
    rounded: "{rounded.md}"
---

# Design System: owlette

## Overview

**Creative North Star: "Mission Control"**

owlette is a console for watching machines nobody is sitting in front of. the screen is a deep navy room, telemetry is the decoration, and one cyan signal marks what is live, interactive or needs you. everything else steps back. density is high on purpose: an operator scans tens of machines at once, so the type is small, the controls are compact, and every row carries five readouts before it carries any ornament.

the personality sits in a few precise mechanics, not in decoration: a hover fill that sweeps left to right like a highlighter, the owlette eye that powers on at first paint, a feather that falls while data loads, a line graph that plots itself. the blueprint and dot grids are the room's walls. they sit at low opacity behind everything and never compete with data.

dark is canonical today, and the app is pinned dark (`<html class="dark">`). a light theme is planned, so new work must keep the light token layer valid even though nothing renders it yet (see Do's and Don'ts).

**Key Characteristics:**
- deep navy surfaces in one hue family (250), separated by lightness steps, not by colour
- signal cyan is the only interactive accent; sodium amber is the rare warm counterpoint
- dense telemetry: 12–14px type, 36px controls, usage-coloured bars and sparklines inside rows
- Geist for everything, Geist Mono for readouts, commands and identifiers
- all copy lowercase
- motion is functional and directional: sweeps run left to right, entrances fade up, and everything stops under reduced motion

## Colors

a cool, near-monochrome navy console lit by one cyan signal and an occasional amber lamp. status and load colours form their own vocabulary on top.

### Primary
- **Signal Cyan** (`signal-cyan`): primary buttons, focus rings, links, selected checkmarks, the landing CTA, and inline code inside hoot answers. it means "live, interactive, yours to act on". `signal-cyan-bright` is its hover step. `signal-cyan-dim` is for quiet cyan structure such as accent grid lines and tinted borders. text on a cyan fill is `signal-cyan-ink`, never white.

### Secondary
- **Sodium Amber** (`sodium-amber`): the warm counterpoint, used sparingly on the landing page (section eyebrows, "attention" states in the display mock-ups) and wherever something warm has to stand apart from the cyan. `sodium-amber-bright` and `sodium-amber-dim` are its hover and quiet steps. the code also defines an `--accent-coral` (oklch 0.70 0.14 30), used in 3 files; treat it as part of the amber family rather than a third accent.

### Neutral
- **Console Navy** (`console-navy`): the page. carries the 20px cyan dot grid on `body`.
- **Sunken Navy** (`sunken-navy`): wells and inset regions inside cards, such as metric strips and chart backgrounds.
- **Popover Navy** (`popover-navy`): popovers and the sidebar.
- **Panel Navy** (`panel-navy`): cards and the machine panels. the main "object" tone.
- **Input Navy** (`input-navy`): input fields (at 30%) and outline buttons (full strength).
- **Control Navy** (`control-navy`): secondary buttons, muted fills, and the frosted menu surface.
- **Hairline Blue** (`hairline-blue`): every border and divider, the accent tint, and the scrollbar thumb.
- **Readout White** (`readout-white`): primary text, very slightly blue.
- **Muted Steel** (`muted-steel`): secondary text, metadata, units, placeholder text, breadcrumb separators.

### Status and load
- **Online Green** (`online-green`): the online dot.
- **Offline Red** (`offline-red`): the offline pill and the restarting / shutting-down countdown pill (which pulses).
- **Alarm Coral** (`alarm-coral`): the themed destructive token. destructive buttons use it at 60%.
- **Warning Yellow / Critical Red** (`warning-yellow`, `critical-red`): temperature readouts that have crossed a threshold. a normal temperature gets no colour at all.
- **Usage bands**: a 0–100% load maps to five hues kept deliberately far apart: under 30 `band-calm-emerald`, under 50 `band-steady-violet`, under 70 `band-working-sky`, under 85 `band-strained-amber`, otherwise `band-critical-red`. the single source is `web/lib/usageColorUtils.ts`.

### Named Rules
**The One Signal Rule.** cyan means interactive or live. don't use it for decoration, headings or illustration fills, or it stops meaning anything.

**The Colour Is an Alarm Rule.** colour on a readout is reserved for crossed thresholds. normal values stay readout white, so a wall of numbers can't hide the one that matters.

**The One Hue Rule.** every navy surface sits at hue 250. drifting hue between near-identical darks reads as a white-balance error, not depth.

## Typography

**Display Font:** Geist (with ui-sans-serif, system-ui, "Segoe UI")
**Body Font:** Geist
**Label/Mono Font:** Geist Mono (with ui-monospace, "Cascadia Mono", Consolas)

**Character:** one neutral grotesque does every job. Geist reads as engineered rather than friendly, and weight and tracking do the hierarchy work. Geist Mono marks things a machine said: commands, IDs, API snippets, panel labels.

### Hierarchy
- **Display** (700, fluid 40→72px, line-height 1.1, tight tracking): the landing hero headline only.
- **Section** (600, fluid 28→40px, tight tracking): landing section headlines. its partner is a light-weight (300) muted subheadline, fluid 16→20px.
- **Headline** (700, 24px below `md`, 30px from `md` up, tight tracking): page titles in the app ("welcome to owlette!").
- **Title** (600, 20px): section and dialog titles. card titles are 600 at leading-none.
- **Body** (400, 14px, line-height 1.43): default UI text. text inputs render at 16px below `md` and 14px from `md` up.
- **Control** (500, 14px): button and tab labels.
- **Label** (500, 12px): the most-used size in the app. metadata, badges, units, table detail lines.
- **Readout** (Geist Mono 400, 12px): command output, IDs, API examples, versions.
- **Micro** (Geist Mono 400, 10–11px, 0.05em tracking, uppercase): mock-up panel captions on the landing page. never body text.

### Named Rules
**The No Orphans Rule.** headings use `text-wrap: balance`, and paragraphs and list items use `text-wrap: pretty`. this has been a platform rule since 2026-08-13.

**The Tabular Rule.** tables and readouts use tabular figures so columns of numbers align as they update.

**The Lowercase Rule.** every user-facing string is lowercase, except acronyms (CPU, GPU, API), proper nouns and user-entered strings. type hierarchy never leans on capitalisation.

## Layout

the app is a full-width console capped at `max-w-screen-2xl` (1536px). a 56px header with a bottom hairline holds a breadcrumb trail (owlette / site ▾ / page ▾) and collapses to a drawer under `md` (768px). page content stacks a headline row with summary stats on the right, then a toolbar row, then the data surface. the machines view switches between a dense table (`table-layout: fixed`, a fixed 72px status column) and a card grid.

spacing follows Tailwind's 4px scale. inside cards, gaps are tight (4–12px) and rows sit flush with hairline dividers. between page sections the gaps open to 24–32px. the landing page uses fluid section padding (64→128px block) and a fluid container (`min(100% - 2rem, 80rem)`). breakpoints are Tailwind's defaults (640 / 768 / 1024 / 1280 / 1536).

**The Flush Row Rule.** telemetry rows stack edge to edge inside their card, separated by hairlines, not gaps. whitespace belongs between objects, not inside a readout.

## Elevation & Depth

depth is tonal. surfaces step up in lightness within hue 250: page 0.145 → sunken 0.19 → popover 0.205 → card 0.23 → control 0.269. machine headers use `card-header`, a 30% mix of sunken into the page tone, so a header reads as distinct from its content. shadows appear only on things that float above the page.

### Shadow Vocabulary
- **Floating panel** (`box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.5)` plus a 1px `rgb(255 255 255 / 0.1)` ring, over 85% control navy with `backdrop-filter: blur(8px)`): dropdowns, popovers, the site switcher. the single source is `MENU_SURFACE` (`web/components/PageHeader.tsx`, mirrored in `desktop/src/lib/surfaces.ts`).
- **Dialog** (`shadow-lg`, over a 50% black overlay with a 4px backdrop blur): modals. the overlay takes the smaller blur step so it reads like the menus.
- **Resting hint** (`shadow-xs` / `shadow-sm`): outline buttons, inputs and cards. barely visible on navy, so treat it as residue, not structure.

### Named Rules
**The Shadows Float Rule.** a surface at rest gets no structural shadow. shadow plus hairline ring is the signature of "this is above the page".

**The No Twin Fills Rule.** never place two large flat fills a hair apart in lightness against a shared hard edge. it reads as a mistake, not depth. to get a darker region, use a vignette that fades to `--card-recessed` with no boundary line (as on the auth brand panel).

## Shapes

corners are small and engineered. the base radius is 6px (`--radius: 0.375rem`). buttons, inputs and menu items use 4px (`rounded-md`), dialogs 6px, cards and machine panels 10px (`rounded-xl`). badges and status pills are fully round, and so is the online dot. borders are 1px hairlines in hairline blue everywhere. a 2px (list) or 4px (card) usage-coloured bar runs down the left edge of each telemetry cell. the scrollbars are thin and navy, with a 6px-radius thumb.

## Components

### Buttons
quiet and precise. the fill is flat at rest and wakes up with a directional sweep.
- **Shape:** gently squared (4px). default height 36px, small 32px, large 40px. icon buttons are square at the same heights.
- **Primary:** signal cyan fill, cyan-ink text, control type.
- **Hover / Focus:** `.btn-sweep` draws a translucent tint across the button from left to right over 200ms (`cubic-bezier(0.4, 0, 0.2, 1)`), and on exit the tint keeps travelling right. the tint is a scrim, not a colour: blue (`oklch(0.62 0.16 250)` at 26%) in dark mode, so it brightens any base without fighting it. keyboard focus adds a faint ring on top of the sweep (see Keyboard Focus). disabled sits at 50% opacity.
- **Outline:** input-navy fill with a hairline-blue border. never revert it to the old `--input` border, which is invisible on a card.
- **Secondary / Ghost:** control-navy fill, or no fill. ghost picks up only the sweep tint.
- **Destructive:** alarm coral at 60% with white text. `ghost-destructive` is a red glyph with no fill, for icon-only deletes.
- **Link:** opts out of the sweep and uses the highlighter link below.
- **Icon-only:** always `IconButton` (`web/components/ui/icon-button.tsx`). its `label` is required and becomes both the accessible name and the tooltip, and it defaults to `type="button"` so it never submits a form by accident.

### Keyboard Focus
- **Default:** keyboard focus is deliberately quiet: a 1px outline at 30% alpha (`oklch(0.5 0.15 250 / 0.3)`) at a 2px offset, buttons add a faint 1px `--ring` at 20% plus the sweep fill, inputs keep their 3px ring at 50%, and menu and listbox rows use their highlight fill. there is no strong focus ring anywhere.

**The Quiet Focus Rule.** focus stays subtle: no full-strength or inset cyan ring on any surface. owner call on 2026-10-02, after a 2px ring added for wcag 1.4.11 read as a box drawn over the ui. the quiet outline measures about 1.3:1, under that criterion's 3:1, and the trade is deliberate. reopen it only with the owner.

### Links
- **Highlighter sweep** (`.hl-link`): links never underline. on hover a selection-style cyan fill sweeps in from left to right, and each glyph flips to navy as the edge crosses it. `.hl-link-muted` (footer) and `.hl-link-plain` (body-text rest colour) change only the palette.

### Chips / Status
- **Status:** online is a 10px green dot with a tooltip. offline is a solid red pill. restarting and shutting down are red pills with an icon and a pulsing `mm:ss` countdown.
- **Badges:** fully round, 12px medium, in the primary, secondary, destructive and outline variants.
- **Metric toggles** (machine detail): small outline chips with a coloured series dot. the active chip takes a tinted fill.

### Cards / Containers
- **Corner Style:** 10px.
- **Background:** panel navy, with sunken-navy wells for metric strips and charts.
- **Shadow Strategy:** none structural (see Elevation & Depth).
- **Border:** 1px hairline blue.
- **Internal Padding:** 24px for generic cards. machine panels run tighter, with flush rows.

### Inputs / Fields
- **Style:** a 30% input-navy fill, a 1px border, 4px radius, 36px tall.
- **Focus:** the border goes cyan, with a 3px cyan ring at 50%.
- **Error:** a destructive border plus a 3px destructive ring that stays visible after blur, so an invalid field can be found at a glance. native date and time pickers follow `color-scheme` per theme.

### Navigation
- **Header:** 56px, console-navy, bottom hairline. it holds the owlette eye mark plus the word "owlette", then `/`-separated breadcrumbs in muted steel. the site and page crumbs open frosted dropdowns. the active page shows in readout white with its lucide icon. under `md` the crumbs collapse into a drawer.

### Telemetry Row (signature)
the machine panel's metric strip, one row each for cpu, ram, disk, gpu and network. a usage-band bar runs down the left edge, a label and device name sit in muted steel, the value is bold in readout white, and units and secondary values are muted. a sparkline fills the row behind the numbers. temperatures take colour only past a threshold. the list view repeats the same anatomy per column with a 2px bar.

### Loading (signature)
the signature loaders: charts plot a miniature line graph on a loop (2.4s), and boot and long loads show the falling feather (two mirrored feathers on a pendulum glide, phase-locked half a cycle apart). inline actions use a small spinning loader icon.

## Do's and Don'ts

### Do:
- **Do** route every interactive or live state through signal cyan, and keep it off everything else.
- **Do** separate surfaces by lightness steps within hue 250 and hairline-blue borders.
- **Do** colour a readout only when it crosses a threshold, using the usage bands or the warning/critical temperature colours.
- **Do** standardize button styling in `web/components/ui/button.tsx` variants. hover feedback comes from `.btn-sweep`, not per-instance `hover:bg-*`.
- **Do** use `MENU_SURFACE` for any floating menu, on web and desktop alike.
- **Do** define every new colour token in both the `:root` (light) and `.dark` blocks of `globals.css`. dark is canonical, but a light theme is planned, so light values must stay valid.
- **Do** use `IconButton` for every icon-only control, with a lowercase label that names the action.
- **Do** honour `prefers-reduced-motion`: every new animation needs a reduced-motion path that ends in its final state.
- **Do** keep `desktop/src/globals.css` in step with web. its dark `--btn-hover` still uses the grey foreground mix that web replaced with the blue tint, which is a known drift.

### Don't:
- **Don't** hardcode colours in components. use the theme tokens. existing raw Tailwind status classes (`red-600`, `green-500`, `amber-*`) are incumbent debt, not precedent.
- **Don't** underline links or give them `hover:text-*`. the highlighter sweep owns link hover.
- **Don't** put structural shadows on resting cards or panels.
- **Don't** place two near-identical flat fills against a shared hard edge.
- **Don't** add a second interactive accent or another icon library. lucide-react is the only icon set.
- **Don't** write title-case or sentence-case UI copy.
- **Don't** add a strong or inset focus ring. the owner rejected it on sight (2026-10-02).
- **Don't** add new uses of the light theme's stock neutral palette (near-black primary, grey surfaces) as if it were the brand. it is shadcn scaffolding until the light theme is designed.
