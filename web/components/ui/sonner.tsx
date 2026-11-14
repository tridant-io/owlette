"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// sonner injects unlayered css, which outranks tailwind's layered utilities, so
// colour classnames on a toast never apply. its colours come from sonner's
// --normal-* variables, and only an !important utility can set those. light
// takes the theme tokens; dark keeps sonner's own surface, which is what dark
// has rendered all along.
const LIGHT_TOASTER =
  "data-[sonner-theme=light]:[--normal-bg:var(--popover)]! data-[sonner-theme=light]:[--normal-border:var(--border)]! data-[sonner-theme=light]:[--normal-text:var(--popover-foreground)]!"

const Toaster = ({ theme, ...props }: ToasterProps) => {
  const { theme: systemTheme = "system" } = useTheme()

  return (
    <Sonner
      theme={(theme || systemTheme) as ToasterProps["theme"]}
      className={`toaster group ${LIGHT_TOASTER}`}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          description: "group-data-[sonner-theme=light]:text-muted-foreground!",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
