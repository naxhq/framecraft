# Third-party fonts

FrameCraft self-hosts both of its typefaces. They are bundled from npm by the
Next build and served from this origin; **no request is ever made to
fonts.googleapis.com or fonts.gstatic.com at runtime**, which `e2e/ui.spec.ts`
asserts ("makes no request to a Google font host").

| Face | Role | Package | Licence |
|---|---|---|---|
| Archivo (variable, wght 100–900) | display: wordmark, group headings, empty state | `@fontsource-variable/archivo` | SIL Open Font License 1.1 — [OFL-Archivo.txt](OFL-Archivo.txt) |
| IBM Plex Sans (variable, wght 100–700) | UI: labels, body, numeric readouts | `@fontsource-variable/ibm-plex-sans` | SIL Open Font License 1.1 — [OFL-IBM-Plex-Sans.txt](OFL-IBM-Plex-Sans.txt) |

Copyright 2020 The Archivo Project Authors (Omnibus-Type).
Copyright 2019 IBM Corp.

The `.woff2` files are not committed: they come from the two packages above,
which are pinned to exact versions in `apps/web/package.json`. The licence
texts are committed here because the OFL requires the licence to travel with
the font software.

## Faces cut into the model

Three more OFL faces are bundled with the bake service and are used for the
*printed* lettering, not the UI. `apps/web/lib/fonts/<face>.glyphs.json` is
their outlines, extracted so the preview can draw what the bake cuts — font
software, served to the browser, so their licences travel here too. The copies
below are written by `services/bake/scripts/gen_font_assets.py` from the
authoritative `services/bake/app/fonts/<face>/OFL.txt`; do not hand-edit them.

| Face | Role | Version | Licence |
|---|---|---|---|
| Inter (`sans`) | border text, default | 4.001 | SIL Open Font License 1.1 — [OFL-Inter.txt](OFL-Inter.txt) |
| Source Serif 4 (`serif`) | border text | 4.005 | SIL Open Font License 1.1 — [OFL-Source-Serif-4.txt](OFL-Source-Serif-4.txt) |
| JetBrains Mono (`mono`) | border text, coordinates | 2.304 | SIL Open Font License 1.1 — [OFL-JetBrains-Mono.txt](OFL-JetBrains-Mono.txt) |

Copyright (c) 2016 The Inter Project Authors.
Copyright 2014-2023 Adobe, with Reserved Font Name 'Source'.
Copyright 2020 The JetBrains Mono Project Authors.
