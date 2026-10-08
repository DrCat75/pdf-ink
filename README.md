# PDF Ink

Handwrite on PDFs inside VS Code. The PDF is rendered with pdf.js, and the ink is stored as vector strokes in page coordinates, so it stays sharp and aligned at any zoom.

## Use
Right-click a PDF → **Open with PDF Ink** (or *Reopen Editor With… → PDF Ink*). To make it the default for PDFs, run *Reopen Editor With…*, then *Configure default editor for '\*.pdf'…*.

| Tool | Key | Notes |
|---|---|---|
| Pen | `P` | pressure-sensitive with a stylus. Mouse and trackpad input use simulated pressure |
| Highlighter | `H` | multiply blend, so text stays readable |
| Eraser | `E` | **Whole stroke** or **Partial**, which cuts strokes where you rub. A pen's eraser end also erases |
| Lasso | `L` / `S` | loop to select, drag to move, `Delete` to remove, click a swatch to recolor |
| Pan | `V`, or hold `Space` | middle-drag also pans |

- Undo / redo: `⌘Z` / `⇧⌘Z` (or the toolbar). Zoom: pinch, `⌘`/`Ctrl` + scroll, `+` `-`, `0` = fit width.
- **Pen only**: touch input scrolls and only the stylus draws (palm rejection on touch screens).
- **Smooth** slider: stabilizes shaky handwriting (0 = raw input).
- **Export** writes a copy of the PDF with the ink baked in as vector paths. The original is never modified.

Works with a mouse or trackpad, but a pressure-sensitive stylus (Wacom, Surface pen, or other pen tablets) feels far better.

## Storage
Ink autosaves to `<file>.pdf.ink.json` next to the PDF. The file is plain JSON:
`{ format, version, pdf, pages: { "<0-based page>": [ { id, c, w, hl?, sp?, pts: [[x, y, pressure], …] } ] } }`.
Coordinates are PDF points at scale 1 with the origin at the page's top-left. Back the file up along with the PDF. Deleting it deletes the ink.

## Privacy
Everything runs locally. The extension makes no network requests and collects no telemetry.

## Known limitations
- PDF links and text selection don't work while the PDF is open in PDF Ink.
- Lasso selections can't be resized or moved to another page yet.
- Ink is matched to the PDF by file name. Rename or move the `.ink.json` together with the PDF.

## License
MIT. Bundles pdf.js (Apache-2.0), perfect-freehand, pdf-lib and their dependencies (MIT/Zlib); see `THIRD_PARTY_NOTICES.md` (included in the extension).

## Build
```
npm install
npm run build      # bundles src/webview.js → media/, copies pdf.js assets
npm run package    # → pdf-ink-<version>.vsix
code --install-extension pdf-ink-<version>.vsix
npm run publish:vsce   # VS Code Marketplace (after `npx vsce login <publisher>`)
npm run publish:ovsx   # Open VSX (needs OVSX_PAT env var)
```
