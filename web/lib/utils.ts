import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// keyboard focus for menu and listbox rows: an inset ring, because the highlight
// fill alone (accent on the menu surface) measures 1.4:1, under wcag 1.4.11
export const ITEM_FOCUS_RING =
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
