#!/usr/bin/sh
# make gate, step 4: bake the Chicago fixture through the BROWSER engine and
# judge both files with the reference validator.
#
# This lives in a file rather than inline in the Makefile for a mechanical
# reason. GNU make hands a recipe to the shell as one `sh -c <script>`, and the
# ezwinports Windows build this host uses truncates that argument at 8 KiB: the
# gate recipe reached 8,466 bytes and the shell received a script that stopped
# mid-`if`, so `make gate` died with "syntax error: unexpected end of file"
# before running a single step. Anything long belongs out here now.
#
# Usage: gate-web-engine.sh <make>      (the $(MAKE) the gate was invoked with)
set -u

MAKE_BIN="${1:-make}"
rc=0

# `make gate` step 0 makes these, but this script has to stand on its own: run
# straight from a clean checkout it used to die on the first redirect below
# instead of baking anything (v3-02 audit finding 15).
mkdir -p artifacts/logs

echo "both files are baked and validated: fixtures/print-params-default.json"
echo "(color_mode=single, the literal default) and print-params-parts.json"
echo "(color_mode=parts). Single mode's 3MF is written from EngineResult.merged,"
echo "a real manifold3d union, so it carries one body like the parts assembly"
echo "does; DECISIONS.md [V3-P2-E2] has the construction and the numbers."

webgate() {
	label="$1"
	params="$2"
	out="$3"
	( cd apps/web && npm run bake:cli -- \
		--scene ../../fixtures/chicago-scene.json \
		--params "../../$params" \
		--target generic-3mf \
		--out "../../$out" ) > "artifacts/logs/bake-cli-$label.log" 2>&1
	bakerc=$?
	cat "artifacts/logs/bake-cli-$label.log"
	if [ $bakerc -ne 0 ]; then
		echo "gate: bake:cli ($label) FAILED" >&2
		return 1
	fi
	"$MAKE_BIN" validate FILE="$out" > "artifacts/logs/validate-web-$label.log" 2>&1
	webvrc=$?
	cat "artifacts/logs/validate-web-$label.log"
	if [ $webvrc -ne 0 ]; then
		echo "gate: make validate on the browser engine's $label file FAILED." >&2
		echo "      Both files read ALL CHECKS PASS as of [V3-P2-E2]; a red row" >&2
		echo "      here is a regression in lib/engine/** and the row names it." >&2
		return 1
	fi
	return 0
}

webgate single fixtures/print-params-default.json artifacts/chicago-web-single.3mf || rc=1
webgate parts fixtures/print-params-parts.json artifacts/chicago-web-parts.3mf || rc=1

exit $rc
