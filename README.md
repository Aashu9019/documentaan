<p align="center">
  <img src="public/icon.svg" width="96" alt="Documentaan logo">
</p>

<h1 align="center">Documentaan (डकुमेन्टान)</h1>

<p align="center">
  A lightweight, offline PDF editor for Windows. View, annotate, sign, fill and organise PDFs.<br>
  Your files never leave your computer.
</p>

<p align="center">
  <a href="https://github.com/Aashu9019/documentaan/releases/latest"><b>Download the latest version</b></a>
</p>

---

## Why Documentaan?

- **Small and fast.** The installer is about 5 to 10 MB and the app opens in about a second.
- **Unlimited signatures.** Save as many signatures and initials as you need, each with its own name.
- **Private.** Everything runs locally. No account, no upload, no internet needed after install.
- **English and Nepali.** Switch the whole interface between English and नेपाली with one click.
- **Free and open source.**

## Features

| Area | What you can do |
|---|---|
| View | Open any PDF, zoom (Ctrl + mouse wheel), fit to width, page thumbnails, search text, light and dark theme |
| Sign | Draw, type (several handwriting fonts) or upload a signature image with automatic background removal. Save unlimited signatures and initials, then place and resize them anywhere |
| Annotate | Text, highlight, freehand pen, rectangle, ellipse, line (hold Shift to snap), sticky notes, check and cross marks, today's date, white-out |
| Forms | Fill in PDF form fields, then flatten them so they can no longer be changed |
| Pages | Drag thumbnails to reorder, rotate, delete, insert blank pages |
| Tools | Merge PDFs, split or extract pages, images to PDF, watermark, page numbers (including Nepali digits), password protection (AES-256) |
| Everyday | Undo and redo, print, Save (overwrites the file) and Save As, double-click a PDF in Windows Explorer to open it |

## Download and install

Go to the [Releases page](https://github.com/Aashu9019/documentaan/releases/latest) and pick one of these files:

| File | Best for |
|---|---|
| `Documentaan_x.y.z_x64-setup.exe` | **Most people.** Installs for your user account only and needs no admin rights |
| `Documentaan_x.y.z_x64_en-US.msi` | Offices and IT admins who deploy software with Group Policy or Intune |

Then:

1. Run the downloaded file.
2. If Windows shows **"Windows protected your PC"**, click **More info**, then **Run anyway**. This appears because the app is new and not yet code-signed. It does not mean the file is harmful.
3. Follow the installer. Documentaan is added to the Start menu.
4. To make it your default PDF app: right-click any PDF, choose **Open with > Choose another app**, select **Documentaan**, and tick **Always use this app**.

To uninstall, open **Settings > Apps > Installed apps**, find Documentaan and click **Uninstall**. Your saved signatures are removed with the app data.

## System requirements

- Windows 10 (version 1803 or later) or Windows 11, 64-bit
- About 30 MB of disk space
- Microsoft Edge WebView2 Runtime. It comes with Windows 10 and 11. If it is missing, the installer downloads it automatically (this one step needs internet)

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl + O | Open |
| Ctrl + S | Save |
| Ctrl + Shift + S | Save as |
| Ctrl + P | Print |
| Ctrl + Z / Ctrl + Y | Undo / Redo |
| Ctrl + + / Ctrl + - | Zoom in / out |
| Delete | Remove the selected item |
| Esc | Back to the select tool |
| Double-click text | Edit it |

## Known limitations

- Nepali (Devanagari) text you add is stored as a sharp image inside the PDF, because the built-in PDF fonts only cover Latin letters. It looks correct but cannot be selected or searched.
- Rotating a page merges that document's annotations into the page, so they can no longer be moved afterwards.
- Editing text that is already part of the original PDF and OCR for scanned documents are not supported yet.

---

## For developers

Documentaan is built with [Tauri 2](https://tauri.app), [Vite](https://vitejs.dev), [pdf.js](https://mozilla.github.io/pdf.js/) for rendering and [pdf-lib](https://github.com/cantoo-scribe/pdf-lib) for editing.

### Requirements

- [Node.js](https://nodejs.org) 22 or later
- [Rust](https://rustup.rs) (stable)
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload

### Commands

```bash
npm install          # install dependencies
npm run dev          # run in the browser at http://localhost:5173
npm run app          # run the desktop app in development mode
npm run app:build    # build the Windows installers
```

Built installers are written to `src-tauri/target/release/bundle/nsis/` (.exe) and `src-tauri/target/release/bundle/msi/` (.msi).

### Publishing a release

Push a version tag and GitHub Actions builds both installers and attaches them to a new release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Remember to bump `version` in `package.json` and `src-tauri/tauri.conf.json` first.

### Project layout

```
index.html            app shell
src/main.js           viewer, annotation tools, page tools, saving
src/signature.js      signature creator (draw, type, upload)
src/store.js          signature storage (IndexedDB)
src/i18n.js           English and Nepali text
src/native.js         desktop integration (file dialogs, open with, close guard)
src-tauri/            Rust backend and installer configuration
```

## License

MIT
