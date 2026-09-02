# Licence and attribution

FrameCraft turns OpenStreetMap data into a printable model. The map data is not
ours and it is not yours: it belongs to the OpenStreetMap contributors, and it
comes with one obligation that travels with everything made from it. This page
says what that obligation is, what FrameCraft does about it on your behalf, what
that does and does not achieve, and what is left for you to do.

## 1. What the licence requires

OpenStreetMap data is published under the **Open Database License 1.0 (ODbL)**,
with the individual map contents under the Database Contents License. The full
text is at <https://opendatacommons.org/licenses/odbl/1-0/> and OSM's own
summary is at <https://www.openstreetmap.org/copyright>.

A FrameCraft model is a **Produced Work** under that licence: it is something
made *from* the database rather than a copy of the database. That distinction
matters, because it decides which rules apply to you.

For a Produced Work, ODbL section 4.3 asks for one thing: an attribution notice
that is **reasonably calculated to make any person that uses, views, accesses,
interacts with, or is otherwise exposed to the Produced Work aware** that the
data came from OpenStreetMap and is available under the ODbL. The notice OSM
asks for is:

> © OpenStreetMap contributors

Two consequences people are often surprised by:

* **A produced work does not have to be share-alike.** You may sell a printed
  model, put it in a shop, or use a photograph of it in an advertisement. What
  you may not do is present it as though the underlying data were yours.
* **The obligation follows the object, not the file.** A photograph of the
  printed model is also exposed to viewers, so the credit belongs in the caption
  or on the page, not only in a file nobody downloads.

If you go further and redistribute the *data* itself rather than a work made
from it, for example by publishing the `SceneGraph` JSON or an extract of the
OSM features, then the share-alike terms of ODbL section 4.4 apply and you have
to offer the derived database under the ODbL too. FrameCraft's `.3mf`, `.stl`,
`.obj` and `.step` outputs are produced works, not databases; its cached
Overpass responses under `fixtures/` are data.

## 2. What FrameCraft engraves into the model

Every bake, with no switch to turn it off, cuts three marks. Each carries
`FrameCraft`, the OpenStreetMap credit and the date the model was generated.
The engine composes those strings from its own constants: the editor cannot
supply them, shorten them or blank them.

| Mark | Where | Size and depth |
|---|---|---|
| Deep underside mark | the base underside, centred, spanning most of the plate | fitted to the plate, about 5.8 mm cap height on a 180 mm plate, 0.6 mm deep (or the deepest the plate can safely carry, never under 0.4 mm) |
| Frame inner-wall mark | all four vertical walls of the frame opening | fitted to the exposed wall, about 1.8 mm cap height on the standard 2 mm lip, 0.4 mm deep |
| Edge microtext | the outer vertical side face of the base | 1.2 mm cap height, 0.2 mm deep |

With the frame switched off there is no inner wall to engrave, so a **second
underside mark** is cut instead, turned 90 degrees and placed in another part of
the plate.

Your own `underside_mark` text is **appended** to the mandatory block, never
substituted for it. Turning `underside_mark` off removes your line and leaves
every mandatory mark exactly where it was.

The two small marks are deliberately finer than a 0.4 mm nozzle can resolve.
That is a choice, not an oversight: they are provenance, and the bake says so
with an informational finding when it happens. They are unambiguous in the mesh
and in a photograph taken with a loupe, whether or not they show on the print.

## 3. What FrameCraft writes into the files

Every exporter carries the same five-field provenance block, in the same order:

```
author      your name, from the "Author" field, blank when you did not set one
license     Model data © OpenStreetMap contributors, ODbL 1.0
generator   FrameCraft 3.0.0
source      lat=..., lon=..., radius_m=...
generated   the ISO 8601 timestamp of the bake
```

* **3MF** (generic and Bambu): `<metadata>` entries, plus the reserved
  `Copyright`, `LicenseTerms`, `Designer` and `Description` fields.
* **OBJ**: `#` header comments at the top of the `.obj` and the `.mtl`.
* **STEP**: the `FILE_DESCRIPTION` strings and the `FILE_NAME` author field.
* **STL**: the 80-byte binary header carries an ASCII short form, and a
  `CREDITS.txt` is written beside the file (a binary STL has nowhere else to put
  it).
* **The sidecar `.json`** carries the same block plus the full parameter set.

## 4. What this does and does not achieve

Be clear-eyed about this. **None of it makes attribution impossible to remove.**

* Engraved plastic can be sanded, filled, painted over or cut away. Somebody
  determined enough will get the marks off a printed object, and no arrangement
  of grooves can stop them.
* A mesh is editable. Anyone with a modelling tool can delete the pockets, and
  anyone with a text editor can delete the metadata from a 3MF or an OBJ.
* File metadata is routinely lost in transit. Re-exporting through a slicer, a
  mesh repair service or a thumbnail generator will often drop it.

What the design does achieve is narrower and worth stating honestly:

* **Casual removal is impractical.** The underside mark spans most of the plate
  and is deep enough that sanding it out visibly thins the plate. The frame
  mark is inside the opening where a sanding block cannot reach without
  destroying the frame profile. The microtext sits on the outer side face, so
  cropping it off changes the model's outer dimensions.
* **Removal leaves evidence.** All three marks have to go, in three different
  places, on three different surfaces. A model that has lost them is visibly a
  model that has been worked on.
* **Provenance is provable.** The marks and the metadata agree with each other
  and with the sidecar, and they name a place and a date. That is enough to
  demonstrate where a model came from, which is what matters in the situations
  where this question is actually asked.

It is a speed bump and a paper trail, not a lock.

## 5. How to comply when you share

**Sharing a photograph, a listing or a video.** Put `© OpenStreetMap
contributors` in the caption, the description or the credits. One line is
enough. If there is room, `Map data © OpenStreetMap contributors, ODbL 1.0` is
better, because it names the licence as well as the source.

**Sharing the model files.** Keep the metadata and the `CREDITS.txt` with them.
If you upload to a model site, repeat the credit in the description field: a
site that re-encodes your upload may strip everything else.

**Selling prints.** Allowed, and the same one-line credit applies. You do not
owe anyone the model files, and you do not have to license your own design work
under the ODbL.

**Publishing the underlying data.** If you extract, publish or redistribute the
OSM features themselves rather than a model made from them, that is a Derivative
Database and section 4.4's share-alike terms apply. Offer it under the ODbL.

**If you remove the marks.** You still owe the attribution. Removing the
engraving removes a convenience FrameCraft provided, not the obligation the
licence created.

## 6. FrameCraft's own licence

The FrameCraft source in this repository is licensed separately from the map
data it processes; see the repository's `LICENSE` file. Nothing in this document
grants rights over OpenStreetMap data beyond what the ODbL itself grants.

## 7. Where this is implemented

* `apps/web/lib/engine/solid/attribution.ts` composes the strings and cuts the
  three marks. `docs/handoff/v3-07-attribution.md` records the measurements and
  the rulings.
* `apps/web/lib/engine/export/common.ts` builds the provenance block; the four
  writers in `apps/web/lib/engine/export/` put it into their own formats.
* `apps/web/lib/engine/solid/attribution.test.ts` checks that every bake carries
  every mark and that every exporter carries the block.
