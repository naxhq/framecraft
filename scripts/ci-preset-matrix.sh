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
#   browser engine       All six presets too, `npm run export:cli --overpass
#                        fixtures/<sha1>.json --center <lat,lon> --rotation
#                        <deg>`, which feeds the raw response through
#                        apps/web/lib/engine/osm.
#
# The browser run used to be Chicago-only for a real reason: a raw Overpass
# response carries no centre of its own (the centre is part of the REQUEST) and
# export-cli.ts hard-coded `DEMO_CENTER` = the Chicago Loop for `--overpass`,
# so the Paris fixture would have been cropped around a point in Illinois and
# built an empty plate. `--center lat,lon` (and `--rotation`, which New York's
# preset needs at 29 deg) closed that gap, and both pipelines are now judged on
# every preset. DECISIONS.md [V3.1-P7-4], docs/handoff/v3-08-siteperf.md.
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
echo "== preset-matrix: the browser engine on every raw Overpass response =="
# One line per preset: `id fixture_file lat lon radius rotation`, read from the
# same committed index the reference run uses, so the two pipelines are given
# the identical request for each city.
web_rows=$(node -e "
  const idx = require('./fixtures/presets-index.json');
  for (const p of idx.presets) {
    const r = p.request || {};
    console.log([p.preset_id, p.fixture_file, r.lat, r.lon, r.radius_m, r.rotation_deg].join(' '));
  }
")
if [ -z "$web_rows" ]; then
	echo "preset-matrix: could not read the preset requests out of presets-index.json" >&2
	rc=1
fi
web_built=0
rm -f "$OUT/.web-failures" "$OUT/.web-built" "$OUT/.web-passed"
echo "$web_rows" | while read -r id fixture lat lon radius rotation; do
	[ -z "$id" ] && continue
	echo "-- web $id"
	log="$LOGS/preset-matrix-web-$id.log"
	( cd apps/web && npm run export:cli -- \
		--overpass "../../fixtures/$fixture" \
		--params ../../fixtures/print-params-parts.json \
		--center "$lat,$lon" \
		--radius "$radius" \
		--rotation "$rotation" \
		--target generic-3mf \
		--out "../../$OUT/web-$id.3mf" ) > "$log" 2>&1
	wrc=$?
	tail -3 "$log"
	if [ $wrc -ne 0 ]; then
		echo "preset-matrix: export:cli --overpass ($id) FAILED (see $log)" >&2
		tail -20 "$log" >&2
		echo "fail" >> "$OUT/.web-failures"
		continue
	fi
	web_built=$((web_built + 1))
	echo "$web_built" > "$OUT/.web-built"
	if judge "web-$id" "$OUT/web-$id.3mf"; then
		echo "pass" >> "$OUT/.web-passed"
	else
		echo "fail" >> "$OUT/.web-failures"
	fi
done
# The loop above runs in a `while read` subshell (POSIX sh has no process
# substitution), so its `rc` assignments do not survive it. The two files are
# how the counts and the failures come back out.
if [ -f "$OUT/.web-failures" ]; then
	web_failed=$(wc -l < "$OUT/.web-failures" | tr -d ' ')
	echo "preset-matrix: $web_failed browser-engine preset run(s) FAILED" >&2
	rm -f "$OUT/.web-failures"
	rc=1
fi
web_total=0
if [ -f "$OUT/.web-built" ]; then
	web_total=$(cat "$OUT/.web-built")
	rm -f "$OUT/.web-built"
fi
web_passed=0
if [ -f "$OUT/.web-passed" ]; then
	web_passed=$(wc -l < "$OUT/.web-passed" | tr -d ' ')
	rm -f "$OUT/.web-passed"
fi

echo
echo "preset-matrix: $built of $count preset(s) built and validated through the reference pipeline"
# Two numbers, not one. A build that succeeds and then fails the validator is a
# different failure from one that never produced a file, and a single "built and
# validated" count would report the first as if it were a success.
echo "preset-matrix: $web_total of $count preset(s) BUILT through the browser engine"
echo "preset-matrix: $web_passed of $count preset(s) VALIDATED CLEAN through the browser engine"
if [ "$web_total" -lt "$count" ]; then
	echo "preset-matrix: the browser engine did not build every preset" >&2
	rc=1
fi
if [ $rc -eq 0 ]; then echo "PRESET-MATRIX PASS"; else echo "PRESET-MATRIX FAIL" >&2; fi
exit $rc
