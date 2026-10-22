# Terminal — the mark

A prompt: a chevron and a cursor, `>_`, in terminal amber on near-black. It names nothing, so it
works for this project and anywhere else you put it.

![the mark](png/terminal-mark-192.png)

## Files

| File | Use it for |
| --- | --- |
| `terminal-mark.svg` | **The logo.** The amber prompt on its own dark square — reads on any background. Favicons, app icons, avatars, a site header. |
| `terminal-glyph-amber.svg` | The prompt alone, amber, no square — on a **dark** page. |
| `terminal-glyph-ink.svg` | The prompt alone, near-black — on a **light** page. |
| `terminal-wordmark-on-dark.svg` | The mark with the name, light lettering on black. |
| `terminal-wordmark-on-light.svg` | The mark with the name, dark lettering, transparent background. |
| `png/terminal-mark-{16,32,180,192,512,1024}.png` | Raster sizes: 16/32 favicon, 180 Apple touch icon, 192/512 web-app icons, 1024 for anything large. |
| `png/terminal-glyph-{amber,ink}-512.png`, `png/terminal-wordmark-on-{dark,light}@3x.png` | Raster versions of the others. |

The PNGs were rendered from the SVGs in Chrome. The wordmark SVGs set their lettering in the
reader's monospace font (IBM Plex Mono, JetBrains Mono, SF Mono, Menlo or Consolas, whichever is
installed), so for an exact match everywhere use the `@3x` PNGs.

## On a website

```html
<link rel="icon" href="/terminal-mark.svg" type="image/svg+xml">
<link rel="icon" href="/terminal-mark-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/terminal-mark-180.png">
```

## Colours

| | Hex | In the app |
| --- | --- | --- |
| Amber | `#ffb000` | prompts, titles, labels |
| Near-black | `#0a0a0a` | panels |
| Black | `#000000` | the page |
| Off-white | `#f2f2f2` | live values |
| Grey | `#8c8c8c` | secondary text |

## Spacing and size

Leave clear space around the mark of at least a quarter of its width, and do not show it smaller
than 16 px. Keep the prompt amber on the dark square; the single-colour glyphs are for places where
the square does not fit.
