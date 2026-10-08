# PDF Ink

Handwrite on PDFs in VS Code with a pen display.

## Getting started
Right-click a PDF → **Open with PDF Ink**.

Tested with an iPad and Apple Pencil as a pen display for a Mac (via Sidecar).

## Tools
| Tool | Key |
|---|---|
| Pen (pressure-sensitive) | `P` |
| Highlighter | `H` |
| Eraser (whole stroke or partial) | `E` |
| Lasso (move, delete, recolor) | `L` |
| Pan | `V` or hold `Space` |

Undo with `⌘Z`, redo with `⇧⌘Z`. Zoom by pinching or with `⌘` + scroll.

**Pen only** makes your finger scroll while only the pen draws. **Smooth** evens out shaky handwriting.

## Your ink
Ink saves automatically to `yourfile.pdf.ink.json` next to the PDF. The PDF itself is never changed. Keep the two files together when you move or rename them.

**Export** creates a copy of the PDF with your ink in it, for example to share.

## Privacy
Everything runs locally. No data leaves your computer.

---
MIT License. Third-party licenses are in `THIRD_PARTY_NOTICES.md`.
Build from source: `npm install && npm run package`.
