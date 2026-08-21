# Vendored browser dependencies

## SheetJS Community Edition

- Version: 0.20.3
- Source: `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js`
- SHA-256: `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41`
- License: Apache-2.0; see `SheetJS-LICENSE.txt`

The browser bundle is pinned locally so spreadsheet contents stay on the Box host/browser and previews do not depend on a third-party CDN at runtime.

## Word document preview

- `docx-renderer` 0.2.2 (Apache-2.0)
- `fflate` 0.8.3 (MIT)
- `jszip` 3.10.1 (MIT)
- `konva` 9.3.22 (MIT)
- `lodash-es` 4.18.1 (MIT)
- Bundle: `docx-renderer.bundle.js`
- License files: `docx-renderer-LICENSE.txt`, `fflate-LICENSE.txt`, `jszip-LICENSE.markdown`, `konva-LICENSE.txt`, and `lodash-es-LICENSE.txt`

The self-contained browser bundle is loaded only when a `.docx` preview is opened. It renders the document locally and removes Word's cached `lastRenderedPageBreak` markers from an in-memory preview copy to avoid stale, nearly blank pages. The original file is never modified.
