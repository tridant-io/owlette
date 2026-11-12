/**
 * "A process row is being dragged right now."
 *
 * A pointer-drag reorder of the process list is indistinguishable from an OS
 * file drop (Tauri `onDragDropEvent`) at the window level, so the internal
 * gesture flags itself here and the drop overlay skips it.
 */

let dragging = false

export function isRowDragging(): boolean {
  return dragging
}

export function setRowDragging(next: boolean): void {
  dragging = next
}
