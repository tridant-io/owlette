# Owlette Tray Icons

## Universal Icon System

Owlette uses a single owl-eye icon, recolored per status, designed to read well on both light and dark Windows themes.

### Directory Structure

```
icons/
├── normal.ico / normal.png              # connected / healthy
├── disconnected.ico / disconnected.png  # running but not reaching the cloud
├── warning.ico / warning.png            # unused
└── error.ico / error.png                # service stopped/crashed or health error
```

ICO files are multi-resolution (16x16–256x256) so Windows can pick the right size per DPI.

### Icon Usage

- **tray**: these PNGs are the source art. The desktop app embeds 64 px downsamples of them from `desktop/src-tauri/icons/tray/` on Windows and Linux and never reads this folder; the macOS menu bar uses its own glyphs there (`template-*.png`, `glyph-*.png`). The yellow icon shown while a swoop session captures the screen, `swoop.png` (`glyph-swoop.png` on macOS), lives only in that folder
- **installer**: `normal.ico` is the Inno Setup installer window icon, and `normal.png` the icon of the uninstall entry
- **warning**: nothing uses it

### Icon Design

All icons are a HAL 9000-inspired owl eye: a warm radial glow — a bright cream center fading through amber to a near-black rim — with a soft catch-light highlight. There is no separate indicator dot; the **whole eye is recolored** to signal status:

- **normal** — warm amber/coral glow (everything OK, connected)
- **disconnected** — dim, muted glow (running but offline)
- **error** — red glow (stopped/crashed or health error)

The warm center against the dark rim keeps the icon legible on both light and dark taskbars.

### Build Integration

The build system (`build_installer_full.bat` and `build_installer_quick.bat`) copies this folder to the installer package, which installs it at `{app}\agent\icons`:

```batch
xcopy /E /I /Y icons\* build\installer_package\agent\icons\
```

A changed tray icon also needs its downsample in `desktop/src-tauri/icons/tray/` redone.
