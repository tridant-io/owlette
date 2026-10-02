import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// keyboard focus for full-width rows and tiles inside a card, where the global
// outline would be clipped by the card edge. menu and listbox rows show focus with
// their highlight fill instead: the ring read as a box drawn over the menu
export const ITEM_FOCUS_RING =
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
