#!/usr/bin/sh
# All six presets, offline, each one validated.
#
# Shared by `make gate-nightly` and nightly.yml's `preset-matrix` job.
#
# WHICH ENGINE BUILDS WHAT, and why it is split:
#
#   reference pipeline   All six presets, `python -m app.cli bake --preset
#                        <id>`. A preset id sets `allow_network=False`, so the
#                        raw Overpass response comes from the committed
#                        `fixtures/<sha1>.json` and nothing touches the
#                        network. This is the only path that exercises ingest
#                        and normalisation on six real cities (16k to 19k
#                        elements each).
#
#   browser engine       Chicago only, `npm run export:cli --overpass
#                        fixtures/<sha1>.json`, which feeds the raw response
#                        through apps/web/lib/engine/osm.
#
# The browser CLI is Chicago-only here for a real reason, not a preference: a
# raw Overpass response carries no centre of its own (the centre is part of the
# REQUEST), export-cli.ts hard-codes `DEMO_CENTER` = the Chicago Loop for
# `--overpass`, and it has no flag to override it. Feeding it the Paris fixture
# would crop Paris data around a point in Illinois and build an empty plate.
# Closing that gap means a `--center lat,lon` flag on export-cli.ts, which is
# application source this script does not get to change. Recorded in
# docs/handoff/v3-14-ci.md.
#
# Usage: ci-preset-matrix.sh [make]
set -u

MAKE_BIN="${1:-make}"
OUT=artifacts/preset-matrix
LOGS=artifacts/logs
rc=0
built=0

mkdir -p "$OUT" "$LOGS"

# The preset ids, read from the committed index rather than hard-coded, so a
# seventh preset is covered the day it is added instead of silently skipped.
presets=$(node -e "
  const idx = require('./fixtures/presets-index.json');
  for (const p of idx.presets) {
    const f = 'fixtures/' + p.fixture_file;
    if (!require('fs').existsSync(f)) {
      console.error('MISSING ' + f + ' for preset ' + p.preset_id);
      process.exitCode = 1;
      continue;
    }
    console.log(p.preset_id);
  }
")
readrc=$?
# The reader's exit status matters on its own. It is 1 when a preset in the
# index has no committed fixture, and the `count -lt 6` guard below would not
# catch that for a SEVENTH preset: six good ones plus one missing still counts
# six (v3-14 audit minor 7).
if [ $readrc -ne 0 ]; then
	echo "preset-matrix: presets-index.json names a preset whose fixture is not committed (see MISSING above)" >&2
	echo "               run 'make refresh-fixtures' while online, or fix the index" >&2
	exit 1
fi
if [ -z "$presets" ]; then
	echo "preset-matrix: fixtures/presets-index.json listed no usable preset" >&2
	exit 1
fi
count=$(echo "$presets" | wc -l | tr -d ' ')
if [ "$count" -lt 6 ]; then
	echo "preset-matrix: expected at least the six committed presets, got $count" >&2
	echo "               a missing fixtures/<sha1>.json is named above" >&2
	exit 1
fi
echo "preset-matrix: $count preset(s) with a committed Overpass fixture"

judge() {
	label="$1"
	file="$2"
	log="$LOGS/preset-matrix-validate-$label.log"
	"$MAKE_BIN" validate FILE="$file" > "$log" 2>&1
	vrc=$?
	cat "$log"
	if [ $vrc -ne 0 ]; then
		echo "preset-matrix: $label - make validate $file FAILED" >&2
		return 1
	fi
	if ! grep -q 'ALL CHECKS PASS' "$log"; then
		echo "preset-matrix: $label - the validator exited 0 without ALL CHECKS PASS" >&2
		return 1
	fi
	return 0
}

echo
echo "== preset-matrix: the reference pipeline, every preset, offline =="
for id in $presets; do
	log="$LOGS/preset-matrix-$id.log"
	echo "-- $id"
	( cd services/bake && uv run python -m app.cli bake \
		--preset "$id" --out "../../$OUT/$id.3mf" ) > "$log" 2>&1
	brc=$?
	tail -3 "$log"
	if [ $brc -ne 0 ]; then
		echo "preset-matrix: bake --preset $id FAILED (see $log)" >&2
		tail -20 "$log" >&2
		rc=1
		continue
	fi
	# `bake` writes the .3mf and the .stl beside it; 04 says the STL is one
	# welded body whatever structure the 3MF carries, so judge both, exactly
	# as `make gate-v2` does.
	judge "$id" "$OUT/$id.3mf" || rc=1
	if [ -s "$OUT/$id.stl" ]; then
		judge "$id-stl" "$OUT/$id.stl" || rc=1
	else
		echo "preset-matrix: $id - no .stl beside the .3mf" >&2
		rc=1
	fi
	built=$((built + 1))
done

echo
echo "== preset-matrix: the browser engine on a raw Overpass response =="
chicago=$(node -e "
  const idx = require('./fixtures/presets-index.json');
  const p = idx.presets.find((x) => x.preset_id === 'chicago-loop');
  if (!p) { console.error('chicago-loop is not in presets-index.json'); process.exit(1); }
  console.log(p.fixture_file);
")
if [ -z "$chicago" ]; then
	echo "preset-matrix: could not resolve the chicago-loop fixture" >&2
	rc=1
else
	log="$LOGS/preset-matrix-web-chicago.log"
	( cd apps/web && npm run export:cli -- \
		--overpass "../../fixtures/$chicago" \
		--params ../../fixtures/print-params-parts.json \
		--target generic-3mf \
		--out "../../$OUT/web-chicago-loop.3mf" ) > "$log" 2>&1
	wrc=$?
	tail -3 "$log"
	if [ $wrc -ne 0 ]; then
		echo "preset-matrix: export:cli --overpass (chicago-loop) FAILED (see $log)" >&2
		tail -20 "$log" >&2
		rc=1
	else
		judge web-chicago-loop "$OUT/web-chicago-loop.3mf" || rc=1
	fi
fi

echo
echo "preset-matrix: $built of $count preset(s) built and validated through the reference pipeline"
if [ $rc -eq 0 ]; then echo "PRESET-MATRIX PASS"; else echo "PRESET-MATRIX FAIL" >&2; fi
exit $rc
