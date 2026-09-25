/**
 * Which desktop this window is on, decided once from the user agent. macOS
 * keeps its native titlebar buttons (`tauri.macos.conf.json` turns
 * decorations on with an overlay titlebar), so the custom Windows-style
 * controls and the drag row's left padding differ by platform.
 */
export const IS_MAC: boolean =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
