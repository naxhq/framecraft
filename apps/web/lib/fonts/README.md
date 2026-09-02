# Derived font assets (GENERATED)

`<face>.metrics.json` and `<face>.glyphs.json` are produced by
`services/bake/scripts/gen_font_assets.py` from the three OFL faces bundled with
the reference service. Do not hand-edit them; regenerate with

```sh
cd services/bake && uv run python scripts/gen_font_assets.py
```

`*.glyphs.json` is **font software**: the flattened outlines of 190 glyphs per
face, in font units, served to the browser so the preview can draw the same
letterforms the build cuts. The SIL Open Font License 1.1 requires its text to
travel with the font software, so the same generator copies each licence into
`apps/web/licences/`.

| Face key | Typeface | Version | Licence |
|---|---|---|---|
| `sans` | Inter | 4.001 | [OFL 1.1](../../licences/OFL-Inter.txt) |
| `serif` | Source Serif 4 | 4.005 | [OFL 1.1](../../licences/OFL-Source-Serif-4.txt) |
| `mono` | JetBrains Mono | 2.304 | [OFL 1.1](../../licences/OFL-JetBrains-Mono.txt) |

Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter).
Copyright 2014-2023 Adobe (http://www.adobe.com/), with Reserved Font Name
'Source'. Copyright 2020 The JetBrains Mono Project Authors
(https://github.com/JetBrains/JetBrainsMono).

The same three faces are credited in every export's `CREDITS.txt` and in the
3MF `LicenseTerms` when a model carries lettering
(`services/bake/app/export/__init__.py`, `FONT_CREDITS`).
