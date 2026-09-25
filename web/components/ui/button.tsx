import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all cursor-pointer disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring/30 focus-visible:ring-ring/20 focus-visible:ring-1 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      // `btn-sweep` sits on each variant rather than in the base string, because
      // `link` genuinely must NOT have it. Both .btn-sweep and .hl-link are
      // unlayered single-class rules, and .btn-sweep is defined later in
      // globals.css — so on a link-variant button it won the `background-image`
      // cascade and replaced .hl-link's three text-clipped layers with one
      // 0%-wide scrim, while .hl-link's `color: transparent` still applied.
      // Result: link buttons painted no text at all until hovered.
      variant: {
        // No `hover:bg-*` here: the .btn-sweep scrim (globals.css) is the hover
        // feedback, and a hover:bg would cross-fade the base colour underneath
        // it and muddy the sweep. Text/border hover stays ordinary utilities.
        default: "btn-sweep bg-primary text-primary-foreground",
        destructive:
          "btn-sweep bg-destructive text-white focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        // Do NOT reinstate `dark:border-input` here: --input (L≈0.25) against a
        // --card surface (L≈0.23) is a 0.02 delta, i.e. no visible edge, and
        // the control read as a stray background. Inheriting the real --border
        // (L≈0.35) plus a full-strength --input fill is what makes it a button.
        outline:
          "btn-sweep border bg-background shadow-xs hover:text-secondary-foreground dark:bg-input dark:hover:text-secondary-foreground",
        secondary: "btn-sweep bg-secondary text-secondary-foreground",
        ghost: "btn-sweep hover:text-secondary-foreground",
        // a quiet destructive action, for icon-only controls: red glyph, no fill.
        "ghost-destructive": "btn-sweep text-destructive hover:text-destructive",
        // link opts out of the button sweep — .hl-link gives it the
        // glyph-accurate text highlight instead.
        link: "hl-link text-primary",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
