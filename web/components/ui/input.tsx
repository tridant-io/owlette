import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-selection selection:text-selection-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm select-text",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        // ring-[3px] here, not just on focus-visible: aria-invalid otherwise
        // only recolours a ring whose width is zero unless the field happens to
        // be focused, so an invalid field the user has moved away from showed a
        // 1px border and nothing else. The point of the invalid state is to be
        // findable at a glance — it needs the outline, focused or not.
        "aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
