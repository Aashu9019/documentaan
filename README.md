# Documentaan (डकुमेन्टान)

A lightweight PDF tool that runs on your own computer. Your files never leave the machine.

## Run
    npm install
    npm run dev        # opens http://localhost:5173

Production build: `npm run build`, then `npm run preview`.

## Features
- View, zoom (Ctrl + mouse wheel), page thumbnails, text search
- Annotate: text, highlight, pen, rectangle, ellipse, line (hold Shift to snap), sticky note, check/cross marks, date, white-out
- **Unlimited saved signatures and initials** (draw, type, or upload an image with background removal), stored in the browser's IndexedDB
- Pages: drag thumbnails to reorder, rotate, delete, insert blank pages
- Merge, split/extract, images to PDF, watermark, page numbers (including Nepali digits), AES-256 password protection, form filling, form flattening
- Undo/redo, Ctrl+S save (overwrites the file in Chromium-based browsers), print
- English / नेपाली interface, light and dark themes

Shortcuts: Ctrl+O open · Ctrl+S save · Ctrl+Shift+S save as · Ctrl+Z / Ctrl+Y undo/redo · Delete removes the selection · Esc · double-click text to edit it.

Note: the standard PDF fonts only cover Latin characters, so Devanagari text is embedded as a high-resolution image (it looks right but can't be selected).
