# Changelog

## 0.3.1
- README: demo animation (writing, lasso, eraser, find, table of contents next to code).

## 0.3.0
- Table of contents: dropdown from the PDF's outline (bookmarks), collapsible, with a filter box and page numbers. Opens at the current section.
- Find in PDF (⌘F / Ctrl+F): highlights all matches, Enter / ⇧Enter (or ⌘G / ⇧⌘G) steps through them, "Aa" toggles match case. Phrases that wrap across lines are found too.

## 0.2.1
- Added GitHub repository and issue tracker links. Simpler README.

## 0.2.0
First public release.
- Pressure-sensitive pen with adjustable stroke smoothing, multiply-blend highlighter
- Eraser: whole stroke or partial (cuts strokes)
- Lasso: select, move, delete, recolor
- Undo/redo, zoom (pinch / ⌘-scroll), pan (Space or hand tool), "pen only" palm rejection
- Ink autosaves to a `<file>.pdf.ink.json` sidecar. The PDF itself is never modified
- Export a copy of the PDF with the ink as vector paths
