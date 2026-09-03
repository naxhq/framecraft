#!/usr/bin/sh
# Every `export_target` the frozen contract lists, plus the tiled variant,
# built by the BROWSER engine from the committed Chicago fixture and judged as
# hard as the format allows.
#
# Shared by `make gate-nightly` and nightly.yml's `export-matrix` job, so the
# two cannot drift. It lives in a file for the same mechanical reason
# `gate-web-engine.sh` does: GNU make hands a recipe to the shell as one
# `sh -c <script>` and the ezwinports Windows build truncates that argument at
# 8 KiB.
#
# TWO KINDS OF ROW, and the script prints which one each target got.
#
#   validated   `make validate` opened the file and every printability check
#               passed: generic-3mf, stl, and each tile of the 2x2 build.
#   structure   The writer ran, the file is non-empty, and the parts that make
#               it that format are present: bambu-3mf, color-change-3mf,
#               stl-parts-zip, obj, step.
#
# WHY THE VALIDATOR DOES NOT JUDGE ALL SEVEN, measured, not assumed:
#
#   * `services/bake/app/cli.py` refuses anything but `.3mf` and `.stl`
#     ("--out must end in .3mf or .stl"), which rules out stl-parts-zip (.zip),
#     obj and step outright.
#   * bambu-3mf and color-change-3mf ARE `.3mf`, and the validator accepts
#     them, but a Bambu project is a MULTI-PART container whose mesh data sits
#     in `3D/Objects/object_1.model` rather than in `3D/3dmodel.model`, and the
#     validator's structural checks do not resolve through that indirection
#     (the same reason smoke.spec.ts's validator tests select `generic-3mf`
#     explicitly; DECISIONS.md [V3-P2-E4]). Run on the full Chicago build it
#     did not finish: 14 minutes of wall clock and 22 CPU-minutes on this host
#     before it was aborted, against 11 seconds for the two generic-3mf files
#     the required CI path validates on every commit. A check that cannot
#     finish is not a check, so these two get the container assertion below.
#
# A `structure` row is weaker than a `validated` one and is labelled as such.
# It relaxes nothing: before this script NO CI job built these five targets at
# all, so the choice was between a container assertion and no check whatever.
# What a Bambu project's per-region extruder assignment actually looks like is
# asserted through the real UI by the `@smoke` test "exporting a Bambu Studio
# project writes every region on its own extruder", which runs on the REQUIRED
# path on every commit.
#
# Usage: ci-export-matrix.sh [make]
set -u

MAKE_BIN="${1:-make}"
OUT=artifacts/export-matrix
LOGS=artifacts/logs
PARAMS=fixtures/print-params-parts.json
SCENE=fixtures/chicago-scene.json
rc=0
validated=0
structural=0

mkdir -p "$OUT" "$LOGS"

# Build one target under an explicit output stem.
#   $1 stem (names the file and the sidecar), $2 target (an `export_target`
#   value, which is NOT always the stem), $3 extension, rest: extra flags.
build_as() {
	stem="$1"
	target="$2"
	ext="$3"
	shift 3
	out="$OUT/$stem$ext"
	log="$LOGS/export-matrix-$stem.log"
	( cd apps/web && npm run export:cli -- \
		--scene "../../$SCENE" \
		--params "../../$PARAMS" \
		--target "$target" \
		--out "../../$out" "$@" ) > "$log" 2>&1
	brc=$?
	tail -1 "$log"
	if [ $brc -ne 0 ]; then
		echo "export-matrix: export:cli --target $target (stem $stem) FAILED (see $log)" >&2
		tail -20 "$log" >&2
		return 1
	fi
	return 0
}

# The common case: the stem IS the target name.
build() {
	target="$1"
	ext="$2"
	shift 2
	build_as "$target" "$target" "$ext" "$@"
}

# `make validate` one file and require the validator's own pass line.
judge() {
	label="$1"
	file="$2"
	log="$LOGS/export-matrix-validate-$(echo "$label" | tr '/ ' '--').log"
	"$MAKE_BIN" validate FILE="$file" > "$log" 2>&1
	vrc=$?
	cat "$log"
	if [ $vrc -ne 0 ]; then
		echo "export-matrix: $label - make validate $file FAILED" >&2
		return 1
	fi
	if ! grep -q 'ALL CHECKS PASS' "$log"; then
		echo "export-matrix: $label - the validator exited 0 without ALL CHECKS PASS" >&2
		return 1
	fi
	validated=$((validated + 1))
	echo "   $label: VALIDATED"
	return 0
}

# Non-empty, and every named string is present in the bytes. A zip stores its
# entry names uncompressed in both the local headers and the central
# directory, so `grep -a` finds them without needing unzip on the runner.
structure() {
	label="$1"
	file="$2"
	shift 2
	if [ ! -s "$file" ]; then
		echo "export-matrix: $label - $file is missing or empty" >&2
		return 1
	fi
	for want in "$@"; do
		if ! grep -a -q "$want" "$file"; then
			echo "export-matrix: $label - $file does not contain /$want/" >&2
			return 1
		fi
	done
	bytes=$(wc -c < "$file" | tr -d ' ')
	structural=$((structural + 1))
	echo "   $label: structure only, $bytes bytes, $# marker(s) present"
	return 0
}

echo "== export-matrix [1/4]: the two the reference validator judges directly =="
if build generic-3mf .3mf; then judge generic-3mf "$OUT/generic-3mf.3mf" || rc=1; else rc=1; fi
if build stl .stl; then judge stl "$OUT/stl.stl" || rc=1; else rc=1; fi

echo
echo "== export-matrix [2/4]: the two Bambu projects (container structure) =="
# PK is the zip magic. 3D/3dmodel.model is the OPC root the 3MF spec requires;
# 3D/Objects/ is where a Bambu PROJECT (as opposed to a plain 3MF) puts the
# mesh, and Metadata/ carries the slicer settings that make it a project at
# all. All three together are what distinguishes this from a generic 3MF.
for t in bambu-3mf color-change-3mf; do
	if build "$t" .3mf; then
		structure "$t" "$OUT/$t.3mf" 'PK' '3D/3dmodel.model' '3D/Objects/' 'Metadata/' || rc=1
	else
		rc=1
	fi
done

echo
echo "== export-matrix [3/4]: the three the validator cannot open at all =="
# The zip's members are written by the same STL writer the `stl` row above
# validated; what is new here is the container and the per-part split.
if build stl-parts-zip .zip; then
	structure stl-parts-zip "$OUT/stl-parts-zip.zip" 'PK' '.stl' || rc=1
else
	rc=1
fi
if build obj .obj; then
	# An OBJ whose mtllib line points at nothing is a broken export that still
	# has a valid header, so the companion is asserted too.
	structure obj "$OUT/obj.obj" 'mtllib' || rc=1
	if [ ! -s "$OUT/obj.mtl" ]; then
		echo "export-matrix: obj - the companion $OUT/obj.mtl was not written" >&2
		rc=1
	else
		echo "   obj: companion obj.mtl written"
	fi
else
	rc=1
fi
if build step .step; then
	structure step "$OUT/step.step" 'ISO-10303-21' 'FILE_SCHEMA' || rc=1
else
	rc=1
fi

echo
echo "== export-matrix [4/4]: tiled 2x2, every tile validated on its own =="
# A tiled build writes a zip of per-tile files (never at --out, whose
# extension does not match a zip) AND each tile as its own file beside it. A
# tile is exactly what the validator judges, and judging a tile is the only
# way to know the SPLIT geometry is sound rather than the model it came from.
# Its own stem: sharing `generic-3mf` with the plain build above meant the
# tiled run overwrote that build's `generic-3mf.json` sidecar, leaving a
# validated .3mf sitting beside a sidecar describing a different build
# (v3-14 audit minor 6).
if build_as generic-3mf-tiled generic-3mf .3mf --tiling 2x2; then
	tiles=0
	for tile in A1 A2 B1 B2; do
		f="$OUT/generic-3mf-tiled-$tile.3mf"
		if [ ! -s "$f" ]; then
			echo "export-matrix: tiled 2x2 - $f was not written" >&2
			rc=1
			continue
		fi
		# export-cli.ts writes a per-tile sidecar next to every tile, and
		# `make validate` judges the file AGAINST that sidecar, so a missing
		# one would silently change what the row proves (audit minor 5).
		if [ ! -s "$OUT/generic-3mf-tiled-$tile.json" ]; then
			echo "export-matrix: tiled 2x2 - tile $tile has no sidecar generic-3mf-tiled-$tile.json" >&2
			rc=1
			continue
		fi
		tiles=$((tiles + 1))
		judge "tile $tile" "$f" || rc=1
	done
	if [ "$tiles" -ne 4 ]; then
		echo "export-matrix: a 2x2 tiling must write 4 tiles with sidecars, found $tiles" >&2
		rc=1
	fi
else
	rc=1
fi

echo
echo "export-matrix: 7 target(s) built; $validated file(s) validated, $structural structure-checked"
if [ $rc -eq 0 ]; then echo "EXPORT-MATRIX PASS"; else echo "EXPORT-MATRIX FAIL" >&2; fi
exit $rc
