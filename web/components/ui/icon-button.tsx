import * as React from "react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type IconButtonProps = Omit<React.ComponentProps<typeof Button>, "aria-label"> & {
  // required: an icon has no text, and a radix tooltip only describes, never names
  label: string
  tooltip?: boolean
}

function IconButton({ label, tooltip = true, size = "icon", ...props }: IconButtonProps) {
  const button = <Button aria-label={label} size={size} {...props} />
  if (!tooltip) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export { IconButton }
