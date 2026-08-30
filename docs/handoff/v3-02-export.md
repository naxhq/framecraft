# v3-02 - Export writers (E3): Bambu project 3MF, generic 3MF, STL, OBJ, STEP, colour change

Scope: `apps/web/lib/engine/export/**` (new, with tests), `apps/web/lib/printers.ts`
(new, with test), `apps/web/scripts/bake-cli.ts` (new) plus the `bake:cli` line in
`apps/web/package.json`, this note, and `[V3-P2-E3]` lines in `DECISIONS.md`.
Nothing else was touched; `lib/engine/types.ts` was only read.

Every exporter is pure: `(result: EngineResult, options) => ExportFile | ExportFile[]`,
no manifold, no DOM, no network. `lib/engine/export/index.ts` dispatches on
`PrintParams.export_target` (`exportForTarget(result, target, options)` returns
`{ files, notes, plan }`).

## 1. Files written per target

| target | files | writer |
|---|---|---|
| `bambu-3mf` | `<stem>.3mf`: `[Content_Types].xml`, `_rels/.rels`, `3D/3dmodel.model`, `3D/_rels/3dmodel.model.rels`, `3D/Objects/object_1.model`, `Metadata/model_settings.config`, `Metadata/project_settings.config`, `Metadata/slice_info.config`, `Metadata/plate_1.json` | `bambu3mf.ts` |
| `color-change-3mf` | the same plus `Metadata/custom_gcode_per_layer.xml`, every part on extruder 1, `<stem>-colorchange.3mf` | `bambu3mf.ts` + `colorchange.ts` |
| `generic-3mf` | `<stem>.3mf`: `[Content_Types].xml`, `_rels/.rels`, `3D/3dmodel.model` (parts or single, see 1.1) | `generic3mf.ts` |
| `stl` | `<stem>.stl`, one binary body, every region concatenated | `stl.ts` |
| `stl-parts-zip` | `<stem>-parts.zip`: `<stem>-NN-<region>-slotK.stl` per region + `CREDITS.txt` | `stl.ts` |
| `obj` | `<stem>.obj` (`o`/`g`/`usemtl` per region, global 1-based indices) + `<stem>.mtl` (`Kd` from the region colour) | `obj.ts` |
| `step` | `<stem>.step`, AP214 faceted B-rep; `notes` carries the size warning | `step.ts` |

Shared behaviour (`common.ts`): regions are ordered by `REGION_NAMES`, empty
meshes dropped, and the model is translated so min x/y are at 0 and the base
underside at z = 0 (`placeInBuildSpace`). Coordinates are written as fixed
decimals with at most six fractional digits, never in scientific notation
(`xml.ts:fmtNum`), which separates any two distinct float32 values under
1000 mm. Colours are `#RRGGBBAA` in 3MF `displaycolor`, `#RRGGBB` everywhere
Bambu reads them. Metadata in every format: title (`"FrameCraft <city_label>"`),
designer, `CreationDate`, `Application` = `FrameCraft 3.0.0`, `Copyright` and
`Description` carrying `© OpenStreetMap contributors`, plus the source
coordinates when the caller passes `options.source`.

### 1.1 Generic 3MF

Core-spec 3MF, the browser twin of `services/bake/app/export/mf3.py`.
`mode` defaults to the params' `color_mode`: `parts` writes `<basematerials
id="1">` with one `<base>` per region, one mesh `<object pid pindex>` per
region, one assembly object whose `<components>` carry identity transforms,
and exactly one `<build><item>`; `single` merges every region into one mesh,
one object, one item. Both shapes pass `app/validate/container.py`'s rows.
`<basematerials>` is core-spec (section 5.1), so no materials-extension
namespace is declared; the non-reserved entries are namespaced `framecraft:`
(`attribution`, `generator`, `scale`, `lat`, `lon`, `radius_m`, `rotation_deg`,
`preset_id`).

### 1.2 STEP

`MANIFOLD_SOLID_BREP` per region under its own `PRODUCT` (named after the
region, so a CAD tree reads "buildings", "water"), `CLOSED_SHELL` of
`ADVANCED_FACE`s on `PLANE`s bounded by `EDGE_LOOP`s of `ORIENTED_EDGE`s over
shared `EDGE_CURVE`s on `LINE`s between shared `VERTEX_POINT`s (welded per
region by exact coordinate). `FILE_DESCRIPTION` carries the title and the
attribution, `FILE_NAME` the author (`params.place.author`, else the designer),
generator and timestamp. `stepCheck(text)` is the structural parser used by the
tests (definitions vs references, duplicates, header, terminator). Above
`triangleWarnLimit` (50 000 by default) `exportStep` returns a note with the
entity count and byte size; zero-area triangles are dropped and counted.

## 2. Bambu Studio project: confirmed facts and where they come from

Source: `bambulab/BambuStudio` master, fetched 2026-08-30 (`version.inc`
02.08.02.61); installed binary 2.8.1.55. Line numbers are in
`src/libslic3r/Format/bbs_3mf.cpp` unless stated.

| fact | evidence |
|---|---|
| `m_is_bbl_3mf` becomes true only when the `Application` metadata starts with `BambuStudio-`; the remainder is parsed as the generator version. `BambuStudio:3mfVersion` is read into `m_version` but no longer sets the flag (assignment commented out). | `_handle_end_metadata`, 4223-4240; constants 107-111, 136 |
| The writer stores `Application` = `SLIC3R_APP_KEY-SLIC3R_VERSION` and `BambuStudio:3mfVersion` = `VERSION_BBS_3MF` (1), plus Title, Origin, Designer, Description, Copyright, License, CreationDate, ModificationDate. | 7255-7275 |
| Without a parseable generator version the loader sets `dont_load_config`; the GUI then shows "The 3mf is not from Bambu Lab, load geometry data and color data only". The GUI also requires `printer_model` to name a BBL vendor model (`is_bbl_vendor_config`) or a consistent `nozzle_diameter` (`check_project_config`). | 1964-1974; `src/slic3r/GUI/Plater.cpp` 303-335, 8448-8536 |
| Namespaces: `xmlns="...core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="...production/2015/06" requiredextensions="p"`. | 7195-7199 |
| Per-object sub-model files `3D/Objects/object_<id>.model`; the main model's object holds only `<components>`, each `<component p:path="/3D/Objects/object_N.model" objectid=V p:UUID transform>`; volume ids run from the object's id, the assembly id follows them. | 7318-7320, 7353, `_add_object_components_to_stream` 7515-7555 |
| Sub-model file: `BambuStudio:3mfVersion` metadata only, one `<object id=V p:UUID=... type="model"><mesh>` per volume (vertices `%.9g`, triangles v1 v2 v3), `<build/>`. | `_add_mesh_to_object_stream` 7581-7822, 7668; `_add_build_to_model_stream` 7824-7850 |
| `p:UUID` scheme: object `%08x(backup_id)` + `-61cb-4c03-9d28-80fed5dfa1dc`; sub-object `%08x(index + (backup_id << 16))` + `-81cb-...`; component the same number + `-b206-40ff-9872-83e8017abed1`; build `2c7c17d8-22b5-4d84-8835-1976022ea369`; item `%08x(object id)` + `-b1ec-4553-aec9-835e5b724bb4`. | 288-293 |
| `3D/_rels/3dmodel.model.rels` lists each sub-model with the 3dmodel relationship type; the reader derives that rels path from the start part and only reads sub-models named there. | writer 7456, 7069-7130; reader 1843-1858, `_handle_start_relationship` 5202 |
| The reader keys objects by (p:path, id): components store the path, build items resolve `objectid` (+ `p:path`, `transform`, `printable`). | `_handle_start_component` 4140-4165, `_handle_start_item` 4182-4197, `_create_object_instance` 4355 |
| `Metadata/model_settings.config`: `<config><object id=A><metadata key="name"/><metadata key="extruder"/><metadata face_count/><part id=V subtype="normal_part"><metadata key="name"/><metadata key="matrix" value="4x4 row-major"/><metadata key="extruder"/><mesh_stat .../></part>...</object><plate><metadata plater_id, plater_name, locked/><model_instance><metadata object_id, instance_id, identify_id/></model_instance></plate><assemble/></config>`. The reader takes `<part id>` as the sub-object id, `name`/`matrix` specially and any other key (so `extruder`) through `config.set_deserialize`. `subtype` strings: `normal_part`, `negative_part`, `modifier_part`. | writer 8198-8560; reader `_handle_start_config_volume` 4505-4533, `_handle_start_config_metadata` 4572-4620, `_generate_volumes_new` 5450-5485; `Model.cpp` 3632-3642 |
| `Metadata/project_settings.config` is `DynamicPrintConfig::save_to_json(..., "project_settings", "project", SLIC3R_VERSION)`: flat JSON, every value a string or string array; the reader is `config.load_from_json`. | writer 8093-8101; reader 2783-2810; `Config.cpp` 848-1000 |
| The CLI dereferences `printer_settings_id`, `print_settings_id`, `filament_settings_id` and `nozzle_diameter` without null checks after loading a Bambu project, so all four are always written. | `src/BambuStudio.cpp` 1968-1972 |
| `Metadata/custom_gcode_per_layer.xml`: `<custom_gcodes_per_layer><plate><plate_info id/><layer top_z type extruder color extra gcode/>...<mode value="SingleExtruder"/></plate></custom_gcodes_per_layer>`; `type` 0 = `CustomGCode::ColorChange`; the reader returns silently for any other root element and ignores `gcode` when `type` is present. | writer 8954-9005; reader 3490-3572; `src/libslic3r/CustomGCode.hpp` 14-20 |
| `Metadata/slice_info.config`: `<config><header><header_item X-BBL-Client-Type/X-BBL-Client-Version/></header>` and `<plate>` blocks only for sliced plates, so an unsliced project carries the header alone. | 8630-8720 |
| `Metadata/plate_N.json` is `PlateBBoxData` (`bbox_all`, `bbox_objects[{id,bbox,area,layer_height,name}]`, `filament_ids`, `filament_colors`, `is_seq_print`, `first_extruder`, `nozzle_diameter`, `version` 2, `bed_type`, `first_layer_time`); written after slicing, no reader in bbs_3mf.cpp (only the `pattern_bbox_file` path attribute). Written for completeness, not referenced from model_settings. | `_add_bbox_file_to_archive` 7052-7066; `src/libslic3r/GCode/ThumbnailData.hpp` 48-112 |
| `Metadata/cut_information.xml` is optional: the reader looks cut ids up with `find` and does nothing when absent. Not written. | 2713, 2295-2300 |
| `[Content_Types].xml` declares rels, model, png and gcode defaults; `_rels/.rels` needs only the 3dmodel relationship (thumbnail relationships are optional paths). | 6944-6958, 7069-7130 |
| Version gates: GUI "cannot be fully loaded" when file major > app major, `Newer3mfVersionDialog` when file version > app version with a different minor; migrations below 1.5.9 and 2.0.0; CLI refuses when file major/minor > CLI. Hence `BambuStudio-02.00.00.00`. | Plater.cpp 8462-8520, 8575, 8685; BambuStudio.cpp 1908-1912 |

The Bambu re-export produced from FrameCraft's generic 3MF by the installed
CLI (`bambu-studio.exe --export-3mf`) was unzipped and compared against the
writer: same content types, rels, model/sub-model layout, `p:UUID` scheme,
`model_settings.config` structure and `slice_info.config` header.

## 3. Printer profiles (`lib/printers.ts`)

`PRINTER_PROFILES` covers the nine `printer_profile` ids; `resolveProfile(params)`
merges `custom_profile` over the `custom` row (a `custom_profile` on a named
printer is ignored). Bambu rows, verified against
`resources/profiles/BBL/machine/*.json` and `resources/profiles/BBL.json`:

| id | printer_model / printer_settings_id | model_id | plate (mm) | print / filament preset |
|---|---|---|---|---|
| bambu-h2s | Bambu Lab H2S / Bambu Lab H2S 0.4 nozzle | O1S | 340 x 320 x 340 | 0.20mm Standard @BBL H2S / Bambu PLA Basic @BBL H2S |
| bambu-p1s | Bambu Lab P1S / Bambu Lab P1S 0.4 nozzle | C12 | 256 x 256 x 250 | 0.20mm Standard @BBL X1C / Bambu PLA Basic @BBL P1S 0.4 nozzle |
| bambu-x1c | Bambu Lab X1 Carbon / Bambu Lab X1 Carbon 0.4 nozzle | BL-P001 | 256 x 256 x 250 | 0.20mm Standard @BBL X1C / Bambu PLA Basic @BBL X1C |
| bambu-a1 | Bambu Lab A1 / Bambu Lab A1 0.4 nozzle | N2S | 256 x 256 x 256 | 0.20mm Standard @BBL A1 / Bambu PLA Basic @BBL A1 |
| bambu-a1-mini | Bambu Lab A1 mini / Bambu Lab A1 mini 0.4 nozzle | N1 | 180 x 180 x 180 | 0.20mm Standard @BBL A1M / Bambu PLA Basic @BBL A1M |

P1S and X1C inherit `printable_area` 256 x 256 from `fdm_bbl_3dp_001_common`
and `printable_height` 250 from `fdm_machine_common`; the others override
them. All Bambu rows: 0.4 mm nozzle, 4 slots (AMS), `M600`. `prusa-mk4`
(250 x 210 x 220), `prusa-mini` (180 x 180 x 180), `ender-3` (220 x 220 x 250):
1 slot, `M600`. `custom` mirrors `DEFAULT_PRINT_PARAMS.custom_profile`.

## 4. Verification against the installed Bambu Studio (2.8.1.55)

What passed:

- Loader acceptance: with the two-cube project as the second input after an
  STL, `bambu-studio.exe --export-3mf` exits with `CLI_FILELIST_INVALID_ORDER`
  (-4, "File list order to the slicer is invalid...") and writes result.json.
  That branch runs only after `Model::read_from_file` parsed the whole project
  and flagged it as a Bambu project (BambuStudio.cpp 1892-1898); a generic
  FrameCraft 3MF in the same position exports with return_code 0. Bambu's own
  re-exported project behaves identically (-4).
- GUI: opening the two-cube project in the Bambu Studio GUI loaded it as a
  project (title "p1s", printer Bambu Lab P1S, nozzle 0.4, process
  "0.20mm Standard @BBL X1C", four filament slots in the file's colours) with
  no "Load 3mf" dialog of any kind; the only top-level dialogs were Bambu's
  "New version of Bambu Studio" and "Configuration update" prompts.

What could not be verified here:

- The full `--export-3mf` round trip with return_code 0 and the re-exported
  `model_settings.config` compared. Bambu Studio 2.8.1.55 on this host dies
  with 0xC0000005 at BambuStudio.dll+0x15e3c3e (Windows Application Error
  log) on `--export-3mf`, `--export-stl` and `--info` of every Bambu-flavoured
  project given as the first file, including the project it had itself just
  exported from FrameCraft's generic 3MF, with or without `--load-settings`,
  `--load-filaments`, `--datadir` or `--slice 0`. Generic 3MF and STL inputs
  export fine. The test (`bambu3mf.test.ts`, "Bambu Studio CLI") asserts the
  preserved part names and extruders whenever result.json appears and prints
  a warning when the CLI crashes; on a Bambu Studio build without the crash it
  becomes the full check without any change.
- The GUI object tree (part names and per-part extruders) was not screenshotted:
  the sidebar needs scrolling and keyboard input could not be injected into the
  interactive desktop from this session. The names and extruders are asserted
  on the file itself.

## 5. CLI

```sh
cd apps/web
npm run bake:cli -- --scene ../../fixtures/chicago-scene.json \
  --params ../../fixtures/print-params-default.json \
  --target bambu-3mf --out ../../artifacts/chicago-web.3mf
```

`--target` accepts any `export_target` value (defaults to the params' own);
`--title` overrides the model title. The script loads the engine dynamically
from `lib/engine/{engine,index}.{ts,js}` (exports `runEngine`, `bake`,
`buildEngineResult` or a default function) so it typechecks today and reports
"the browser engine (apps/web/lib/engine/engine.ts) is not available yet" until
E2 lands. It writes the export (companions such as the MTL beside it), a
`<stem>.json` sidecar in the Python bake's shape (`attribution`, `license`,
`generator`, `created_at`, `print_params`, `bake_result` with `files`/`stats`/
`warnings`, `scene_stats`, `validation: null`, `timings_s`) for
`make validate FILE=...`, and `CREDITS.txt`.

## 6. Tests

`npx vitest run lib/engine/export lib/printers`: 10 files, 78 tests, all
green (about 1.5 s; the Bambu CLI probes add roughly 1.2 s when the executable
is installed).

| file | tests | covers |
|---|---|---|
| `zip.test.ts` | 5 | entry order, round trip, determinism, mtime, bad names |
| `xml.test.ts` | 11 | escaping, `fmtNum` (no exponent, float32 separation), strict parser |
| `generic3mf.test.ts` | 15 | three OPC parts, unit, basematerials colours, mesh objects with pid/pindex, assembly with identity transforms, one build item, vertex/triangle counts, build-space placement, metadata, reproducibility, region ordering, single variant, index offsets |
| `bambu3mf.test.ts` | 11 | package entries, namespaces and `Application`, assembly with `p:path` components and one item, sub-model meshes, part names and extruders, project_settings from the profile, slice_info/plate_1.json, slot beyond profile, third-party profile, single-nozzle project, Bambu CLI probes |
| `colorchange.test.ts` | 6 | stacked cubes separable, side-by-side inseparable, band merging, sample conflicts, layer snapping, XML layout |
| `stl.test.ts` | 6 | 84 + 50 x triangles, header, normals, degenerate triangle, index check, parts zip |
| `obj.test.ts` | 5 | files, header comments, groups and face count, placement, Kd |
| `step.test.ts` | 9 | header/schema, balanced references, products per region, box and L-shape topology counts, size note, degenerate triangles, real/string formatting, checker |
| `index.test.ts` | 4 | every target covered and labelled, file names per target, plan and notes pass-through |
| `lib/printers.test.ts` | 6 | table completeness, Bambu identities, custom row vs contract defaults, `resolveProfile` |

`npm run typecheck` is clean for the whole app. `npm run lint` is clean for
every file in this scope (run on `lib/engine/export`, `lib/printers*.ts`,
`scripts/bake-cli.ts`); the whole-project lint currently reports 2 errors and
5 warnings in `lib/engine/osm/**` and `lib/engine/solid/**`, which belong to
the E1 and E2 builders working in parallel.

## 7. For the integrator (E4)

- `exportForTarget(result, params.export_target, { source: { lat, lon, ... }, stem, title })`
  gives `{ files, notes, plan }`; hand `files` to the download, show `notes`
  (STEP size, colour-change plan) and `plan.inseparable` in the Issues badge.
- `resolveProfile(params)` is the one place the printer table is read; the
  Bambu writer takes it from `result.params` unless `options.profile` is given.
- `planColorChanges(result.regions)` can run on the live engine result to
  preview the bands before exporting.
- Nothing here is committed; all changes are working-tree.
