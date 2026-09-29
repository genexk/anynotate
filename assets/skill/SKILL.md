---
name: annotations
description: Read browser annotations the user sent with Anynotate. Use when the user types /annotations, mentions browser notes or annotations, or a prompt says "Browser notes waiting".
---

# Browser annotations (Anynotate)

1. With no argument, run `anynotate annotations` and show the list: id, status, target agent, page title.
2. With an id or `latest`, run `anynotate annotations <id|latest>`. It prints the bundle README and its folder, and marks the bundle as read.
3. Treat each note as an instruction about that page:
   - `page.md`: search for the marker `⟦A1⟧` to see where a note sits in the page structure.
   - `crops/A<n>.png`: view it for charts, canvases and visual detail.
   - `screenshot.png`: overall layout.
   - `annotations.json`: exact selectors and element HTML.
   - `snapshot.html`: never read it whole; grep it for specifics.
4. Restate briefly what the user wants for each note, then act on it.
