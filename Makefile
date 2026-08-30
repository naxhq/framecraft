SHELL := sh
.DEFAULT_GOAL := help
.PHONY: help install contracts up dev down test gate gate-v2 bake-fixture validate refresh-fixtures clean

help:
	@echo "FrameCraft make targets:"
	@echo "  help              show this message (default)"
	@echo "  install           uv sync (services/bake) + npm ci (apps/web) + playwright chromium"
	@echo "  contracts         regenerate contracts.py and contracts.ts from packages/contracts/schema"
	@echo "  up                start bake (:8000) and web (:3000); docker compose if available, else native"
	@echo "                    (FRAMECRAFT_WEB_MODE=prod serves next build + next start instead of next dev)"
	@echo "  dev               native foreground dev, both services, Ctrl-C stops both"
	@echo "  down              stop both services"
	@echo "  test              pytest (services/bake) + vitest (apps/web)"
	@echo "  gate              G4/G7: no-skip guard + pytest + lint + tsc + vitest + next build +"
	@echo "                    playwright (stack up/down); fails on ANY skipped or xfailed test"
	@echo "  gate-v2           the v2 bake-side gates end to end: G8, G5 at plate 180 and 256,"
	@echo "                    G6, COLOR=parts TEXT=all, and make validate on every .3mf and .stl"
	@echo "  bake-fixture      bake the Chicago preset to artifacts/chicago.3mf"
	@echo "                    (COLOR=parts -> artifacts/chicago-parts.3mf; PLATE=<100..256>"
	@echo "                     -> artifacts/chicago-p<mm>.3mf; TEXT=all -> chicago-text.3mf"
	@echo "                     with every frame ornament. All three compose.)"
	@echo "  validate FILE=x   run the printability validator CLI on FILE (or: make validate x)"
	@echo "  refresh-fixtures  re-fetch and re-cache the Overpass fixtures"
	@echo "  clean             remove .next, baked artifacts, .run, and logs"

install:
	cd services/bake && uv sync
	cd apps/web && npm ci
	cd apps/web && npx playwright install chromium

contracts:
	@command -v python3 >/dev/null 2>&1 && PY=python3 || PY=python; \
	$$PY packages/contracts/gen_py.py && $$PY packages/contracts/gen_ts.py

up:
	@if docker compose version >/dev/null 2>&1 && [ -f docker-compose.yml ]; then \
		docker compose up -d --build; \
	else \
		mkdir -p artifacts/logs .run; \
		ROOT="$$PWD"; \
		pid_on_port() { netstat -ano 2>/dev/null | grep LISTENING | grep ":$$1 " | awk '{print $$NF}' | head -1; }; \
		start_native() { \
			name="$$1"; port="$$2"; dir="$$3"; shift 3; \
			recorded=""; \
			if [ -f "$$ROOT/.run/$$name.pid" ]; then recorded=$$(cat "$$ROOT/.run/$$name.pid"); fi; \
			existing=$$(pid_on_port "$$port"); \
			if [ -n "$$existing" ]; then \
				if [ -n "$$recorded" ] && [ "$$existing" = "$$recorded" ]; then \
					echo "$$name already running (pid $$existing)"; return 0; \
				fi; \
				echo "error: port $$port already in use by pid $$existing (not started by make up); stop it or choose a free port" >&2; \
				exit 1; \
			fi; \
			if [ -n "$$recorded" ] && kill -0 "$$recorded" 2>/dev/null; then \
				echo "$$name already running (pid $$recorded)"; return 0; \
			fi; \
			( cd "$$dir"; "$$@" > "$$ROOT/artifacts/logs/$$name.log" 2>&1 & echo $$! > "$$ROOT/.run/$$name.pid" ); \
			if command -v taskkill >/dev/null 2>&1; then \
				j=0; real=""; \
				while [ $$j -lt 30 ] && [ -z "$$real" ]; do \
					real=$$(pid_on_port "$$port"); \
					if [ -z "$$real" ]; then sleep 1; j=$$((j+1)); fi; \
				done; \
				if [ -n "$$real" ]; then echo "$$real" > "$$ROOT/.run/$$name.pid"; fi; \
			fi; \
			echo "started $$name (pid $$(cat "$$ROOT/.run/$$name.pid" 2>/dev/null))"; \
		}; \
		start_native bake 8000 services/bake uv run uvicorn app.main:app --host 127.0.0.1 --port 8000; \
		if [ "$$FRAMECRAFT_WEB_MODE" = "prod" ]; then \
			if [ -z "$$(pid_on_port 3000)" ]; then \
				echo "building the production web bundle (FRAMECRAFT_WEB_MODE=prod)"; \
				( cd apps/web && npm run build ) || exit 1; \
			fi; \
			start_native web 3000 apps/web npm run start; \
		else \
			start_native web 3000 apps/web npm run dev; \
		fi; \
	fi
	@echo "waiting for bake and web to become healthy (up to 120s)..."; \
	i=0; \
	while [ $$i -lt 120 ]; do \
		if curl -sf http://localhost:8000/health >/dev/null 2>&1 && curl -sf http://localhost:3000 >/dev/null 2>&1; then \
			echo "up: bake and web are healthy"; \
			exit 0; \
		fi; \
		i=$$((i+1)); \
		sleep 1; \
	done; \
	echo "timed out waiting for services after 120s (see artifacts/logs/)" >&2; \
	exit 1

dev:
	@trap 'kill 0' INT TERM EXIT; \
	( cd services/bake && uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 ) & \
	( cd apps/web && npm run dev ) & \
	wait

# Stops both services AND says so with its exit code.  Every kill below is
# `|| true` (a service that was never started is not an error) and every branch
# ends in an echo, so this recipe used to return 0 unconditionally - which made
# `make gate`'s "a failing `make down` fails the gate" check unreachable, and
# only the port probe beside it had any teeth (v2-07 audit, finding 6).  The
# assertion that means something on this host is the PORT: after the kill, 8000
# and 3000 have to be free, whoever was holding them.
down:
	@rc=0; \
	pid_on_port() { netstat -ano 2>/dev/null | grep LISTENING | grep ":$$1 " | awk '{print $$NF}' | head -1; }; \
	if docker compose version >/dev/null 2>&1 && [ -f docker-compose.yml ]; then \
		docker compose down || { echo "down: docker compose down FAILED" >&2; rc=1; }; \
	fi; \
	for name in bake web; do \
		case "$$name" in bake) port=8000 ;; web) port=3000 ;; esac; \
		if [ -f .run/$$name.pid ]; then \
			pid=$$(cat .run/$$name.pid); \
			if command -v taskkill >/dev/null 2>&1; then \
				taskkill //PID "$$pid" //T //F >/dev/null 2>&1 || true; \
			else \
				kill "$$pid" >/dev/null 2>&1 || true; \
			fi; \
			rm -f .run/$$name.pid; \
			echo "stopped $$name"; \
		fi; \
		j=0; \
		while [ $$j -lt 15 ] && [ -n "$$(pid_on_port $$port)" ]; do sleep 1; j=$$((j+1)); done; \
		survivor=$$(pid_on_port $$port); \
		if [ -n "$$survivor" ]; then \
			echo "down: port $$port is STILL held by pid $$survivor - $$name did not stop" >&2; \
			rc=1; \
		fi; \
	done; \
	exit $$rc

test:
	cd services/bake && uv run pytest -q
	cd apps/web && npm test

# G4 (v1) / G7 (v2). Runs everything, in order, and never leaves the stack up:
#   1. a STATIC no-skip guard over every vitest and Playwright source file
#   2. pytest (services/bake), which fails the gate on a skip/xfail as well as
#      on a failure
#   3. lint, typecheck, vitest, next build   (apps/web), each attributed
#   4. make up -> the Playwright suite -> make down (down even on failure)
#   5. the teardown is CHECKED: a failing `make down`, or a port still
#      listening after it, fails the gate. "never leaves the stack up" is an
#      assertion, not a hope - a survivor holds :8000/:3000 and makes the next
#      `make up` a hard error (DECISIONS [P1-fix]).
#   6. fixtures/ is CHECKED: the e2e drives one live Overpass query, which
#      caches a `fixtures/<sha1>.json`; the specs prune it in `afterAll` and
#      the gate fails if one survived (a 100 MB uncommittable file otherwise
#      shows up in the next `git status`).
#
# ZERO SKIPPED TESTS is a gate condition, in four independent places: the
# static guard (step 1) catches a marker that was committed, the pytest summary
# check (step 2) catches a runtime skip/xfail on the Python side, the vitest
# summary (step 3) catches one there, and `results.json stats.skipped` (step 5)
# catches one on the Playwright side. Playwright and pytest both exit 0 on a
# skip, so none of these is redundant.
#
# ZERO EXPECTED FAILURES too, since v2-07 audit finding 3: Playwright's
# `test.fail()` is its xfail, it lands in `stats.expected` rather than in
# `stats.skipped`, and nothing saw it. Step 1's alternation now carries `fail`
# and step 5 walks the suite tree for `expectedStatus != "passed"`, so the
# static and the runtime halves each catch it on their own.
#
# Exits non-zero if ANY step failed. `next build` deliberately runs BEFORE
# `make up`: building into .next while `next dev` is serving it corrupts the
# dev server (DECISIONS [P4]). The reverse order is safe here because `make up`
# HEALTH-WAITS on http://localhost:3000 for up to 120 s, so `next dev` finishes
# recompiling the tree the build left before Playwright is ever launched --
# unlike `npm run test:e2e` on its own, whose webServer starts driving the page
# as soon as the port answers. Measured, see apps/web/playwright.config.ts.
gate:
	@rc=0; \
	mkdir -p artifacts/logs; \
	port_listening() { \
		netstat -ano 2>/dev/null | grep LISTENING | grep -q ":$$1 " && return 0; \
		curl -sf -o /dev/null --max-time 5 "http://localhost:$$1/" && return 0; \
		curl -sf -o /dev/null --max-time 5 "http://localhost:$$1/health" && return 0; \
		return 1; \
	}; \
	echo "== gate [0/7] stopping any running stack (the gate owns the lifecycle) =="; \
	$(MAKE) down > artifacts/logs/down.log 2>&1 || true; \
	echo "== gate [1/7] no-skip guard (static, every vitest + playwright source) =="; \
	specs=$$(find apps/web -type d \( -name node_modules -o -name .next \) -prune -o \
		-type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \) -print); \
	if [ -z "$$specs" ]; then \
		echo "gate: found no vitest/playwright source files at all - the glob is wrong" >&2; rc=1; \
	else \
		echo "$$(echo "$$specs" | wc -l | tr -d ' ') test files scanned"; \
		markers=$$(echo "$$specs" | xargs grep -nE \
			'(^|[^A-Za-z0-9_$$])(test|it|describe|suite|bench)\.(skip|only|fixme|todo|skipIf|failing|fail)\b|(^|[^A-Za-z0-9_$$])(xit|xtest|xdescribe)[[:space:]]*\(' \
			2>/dev/null || true); \
		if [ -n "$$markers" ]; then \
			echo "gate: a skip/only/todo/fail marker is committed in a test source:" >&2; \
			echo "$$markers" >&2; \
			echo "      the gate accepts no skipped, focused, pending or expected-failure" >&2; \
			echo "      test (V2-P7). Playwright's test.fail() is the analogue of pytest's" >&2; \
			echo "      xfail, which step 2 already rejects." >&2; \
			rc=1; \
		else \
			echo "no test.skip / .only / .todo / .fixme / .fail / xit marker anywhere"; \
		fi; \
	fi; \
	echo "== gate [2/7] pytest (services/bake), and it must skip nothing =="; \
	( cd services/bake && uv run pytest -q -rs ) > artifacts/logs/pytest.log 2>&1; \
	pyrc=$$?; \
	cat artifacts/logs/pytest.log; \
	[ $$pyrc -eq 0 ] || { echo "gate: pytest FAILED" >&2; rc=1; }; \
	if grep -qE '[0-9]+ (skipped|xfailed|xpassed)' artifacts/logs/pytest.log; then \
		echo "gate: pytest reported skipped/xfailed test(s) - the gate does not accept one:" >&2; \
		grep -E '^SKIPPED|^XFAIL|[0-9]+ (skipped|xfailed|xpassed)' artifacts/logs/pytest.log >&2 || true; \
		rc=1; \
	fi; \
	echo "== gate [3/7] lint + typecheck + vitest + next build (apps/web) =="; \
	( cd apps/web && npm run lint ) || { echo "gate: eslint FAILED" >&2; rc=1; }; \
	( cd apps/web && npm run typecheck ) || { echo "gate: tsc --noEmit FAILED" >&2; rc=1; }; \
	( cd apps/web && npm test ) > artifacts/logs/vitest.log 2>&1; \
	vrc=$$?; \
	cat artifacts/logs/vitest.log; \
	[ $$vrc -eq 0 ] || { echo "gate: vitest FAILED" >&2; rc=1; }; \
	if grep -qE '[0-9]+ (skipped|todo)' artifacts/logs/vitest.log; then \
		echo "gate: vitest reported skipped/todo test(s) - the gate does not accept one" >&2; \
		grep -E '[0-9]+ (skipped|todo)' artifacts/logs/vitest.log >&2 || true; \
		rc=1; \
	fi; \
	( cd apps/web && npm run build ) || { echo "gate: next build FAILED" >&2; rc=1; }; \
	if [ $$rc -ne 0 ]; then \
		echo "gate: skipping the Playwright suite after an earlier failure" >&2; \
	else \
		echo "== gate [4/7] playwright chromium =="; \
		if ( cd apps/web && node -e "const{chromium}=require('@playwright/test');if(!require('fs').existsSync(chromium.executablePath()))process.exit(1)" ) 2>/dev/null; then \
			echo "chromium is installed"; \
			echo "== gate [5/7] make up + the Playwright suite =="; \
			rm -f artifacts/e2e/results.json; \
			if FRAMECRAFT_OFFLINE= $(MAKE) up > artifacts/logs/up.log 2>&1; then \
				( cd apps/web && npm run test:e2e ) || { echo "gate: the Playwright suite FAILED" >&2; rc=1; }; \
				node -e "const r=require('./artifacts/e2e/results.json');const s=(r.stats||{});const n=s.skipped||0;const bad=[];const walk=(u)=>{for(const sp of (u.specs||[])){for(const t of (sp.tests||[])){const e=t.expectedStatus||'passed';if(e!=='passed')bad.push(sp.title+' [expectedStatus='+e+']')}}for(const c of (u.suites||[]))walk(c)};for(const u of (r.suites||[]))walk(u);if(n){console.error('gate: '+n+' Playwright test(s) SKIPPED - the gate does not accept a skipped acceptance test');process.exit(1)}if(bad.length){console.error('gate: '+bad.length+' Playwright test(s) annotated test.fail() - an expected-failure asserts nothing, exactly like the pytest xfail step 2 rejects:');for(const b of bad)console.error('        '+b);process.exit(1)}console.log('playwright: '+(s.expected||0)+' passed, '+(s.unexpected||0)+' failed, '+(s.flaky||0)+' flaky, 0 skipped, 0 expected-failure')" \
					|| { echo "gate: playwright reported skipped or expected-failure test(s) (see artifacts/e2e/results.json)" >&2; rc=1; }; \
			else \
				echo "gate: make up FAILED (see artifacts/logs/up.log)" >&2; \
				tail -20 artifacts/logs/up.log >&2 || true; \
				rc=1; \
			fi; \
			echo "== gate [6/7] teardown (always attempted, and checked) =="; \
			if $(MAKE) down > artifacts/logs/down.log 2>&1; then \
				echo "stack stopped"; \
			else \
				echo "gate: 'make down' FAILED - the stack may still be running (see artifacts/logs/down.log)" >&2; \
				tail -20 artifacts/logs/down.log >&2 || true; \
				rc=1; \
			fi; \
			busy=""; \
			for p in 8000 3000; do \
				if port_listening "$$p"; then busy="$$busy $$p"; fi; \
			done; \
			if [ -n "$$busy" ]; then \
				echo "gate: port(s)$$busy still listening after 'make down' - the gate must not leave a stack up" >&2; \
				echo "      stop the survivor(s) before re-running (netstat -ano | grep LISTENING)" >&2; \
				rc=1; \
			fi; \
			echo "== gate [7/7] fixtures/ is clean (the e2e pruned what it cached) =="; \
			if command -v git >/dev/null 2>&1; then \
				stray=$$(git status --porcelain -- fixtures/ 2>/dev/null | cut -c4- | tr -d '"' \
					| grep -E '(^|/)[0-9a-f]{40}\.json$$' || true); \
				if [ -n "$$stray" ]; then \
					echo "gate: a non-preset Overpass fixture survived the e2e:" >&2; \
					echo "$$stray" >&2; \
					echo "      the suites prune them in afterAll; one left behind means a spec" >&2; \
					echo "      aborted, or a new spec reaches Overpass without pruning." >&2; \
					rc=1; \
				else \
					echo "no stray sha1 fixture in fixtures/"; \
				fi; \
			else \
				echo "gate: git is not on PATH, cannot check fixtures/ for strays" >&2; rc=1; \
			fi; \
		else \
			echo "gate: Playwright's chromium is not installed." >&2; \
			echo "      run: cd apps/web && npx playwright install chromium   (or: make install)" >&2; \
			rc=1; \
		fi; \
	fi; \
	if [ $$rc -eq 0 ]; then echo "GATE PASS"; else echo "GATE FAIL" >&2; fi; \
	exit $$rc

# The v2 bake-side gates, end to end, in one command. `make gate` is unchanged
# and still means G4/G7 (the test suites and the browser); this is the geometry
# half, which needs several minutes of manifold3d and so is deliberately NOT
# folded into it.
#
#   [1] G8  services/bake tests/test_v1_compat.py - a default-constructed v2
#           PrintParams still bakes the committed v1 golden byte for byte.
#           11 passed is ASSERTED, and so is "nothing skipped": checking only
#           the exit code left a `skipif` here invisible (v2-07 audit, 8)
#   [2] G5  COLOR=parts at the DEFAULT 180 mm plate -> 6 parts / 6 materials
#           (trees do not survive stage 1 at 1:10,714, so there is no trees part)
#   [3] G5  COLOR=parts PLATE=256 -> chicago-parts-p256, 7 parts / 7 materials
#   [4] G6  TEXT=all - every ornament, and the `lettering` and `base_floor`
#           rows have to PASS *with a non-zero stroke count*: `PASS` alone was
#           satisfiable with nothing cut at all (v2-07 audit, 2), so the
#           patterns below grep the NUMBER, not the word
#   [5]     COLOR=parts TEXT=all, the two composed
#
# Every output is judged twice: `make validate` on the `.3mf` AND on the `.stl`
# beside it, because 04 says the STL is one welded body whatever structure the
# 3MF carries. Every step's table is echoed and kept under artifacts/logs/.
gate-v2:
	@rc=0; \
	mkdir -p artifacts/logs; \
	need() { \
		log="$$1"; shift; \
		for pattern in "$$@"; do \
			if ! grep -qE "$$pattern" "$$log"; then \
				echo "gate-v2: expected /$$pattern/ in $$log" >&2; rc=1; \
			fi; \
		done; \
	}; \
	check() { \
		label="$$1"; target="$$2"; log="$$3"; shift 3; \
		$(MAKE) validate FILE="$$target" > "$$log" 2>&1; vrc=$$?; \
		cat "$$log"; \
		if [ $$vrc -ne 0 ]; then echo "gate-v2: $$label - make validate $$target FAILED" >&2; rc=1; fi; \
		need "$$log" 'ALL CHECKS PASS' "$$@"; \
	}; \
	bake() { \
		label="$$1"; log="$$2"; shift 2; \
		echo "-- $$label: make bake-fixture $$*"; \
		if ! $(MAKE) bake-fixture "$$@" > "$$log" 2>&1; then \
			echo "gate-v2: $$label - make bake-fixture $$* FAILED (see $$log)" >&2; \
			tail -20 "$$log" >&2 || true; \
			rc=1; return 1; \
		fi; \
		tail -3 "$$log"; \
		return 0; \
	}; \
	echo "== gate-v2 [1/5] G8: a default v2 PrintParams reproduces the v1 golden =="; \
	( cd services/bake && uv run pytest tests/test_v1_compat.py -q -rs ) \
		> artifacts/logs/gate-v2-g8.log 2>&1; \
	g8rc=$$?; \
	cat artifacts/logs/gate-v2-g8.log; \
	[ $$g8rc -eq 0 ] || { echo "gate-v2: G8 FAILED" >&2; rc=1; }; \
	need artifacts/logs/gate-v2-g8.log '(^|[^0-9])11 passed'; \
	if grep -qE '[0-9]+ (skipped|xfailed|xpassed)' artifacts/logs/gate-v2-g8.log; then \
		echo "gate-v2: G8 reported skipped/xfailed test(s) - a skipif here would leave" >&2; \
		echo "         this step green while asserting nothing about the v1 golden" >&2; \
		rc=1; \
	fi; \
	echo; echo "== gate-v2 [2/5] G5 at the default 180 mm plate: 6 parts, 6 materials =="; \
	if bake "G5/180" artifacts/logs/gate-v2-g5-180-bake.log COLOR=parts; then \
		check "G5/180" artifacts/chicago-parts.3mf artifacts/logs/gate-v2-g5-180.log \
			'^parts +6:' '3mf_materials +PASS +6 entries' \
			'3mf_components +PASS +6 components, 6 distinct' \
			'3mf_objects +PASS +6 mesh \+ 1 assembly' \
			'3mf_color_mode +PASS' 'part_meshes +PASS' 'bodies +PASS +6 parts'; \
		check "G5/180 stl" artifacts/chicago-parts.stl artifacts/logs/gate-v2-g5-180-stl.log \
			'bodies +PASS +1 '; \
	fi; \
	echo; echo "== gate-v2 [3/5] G5 at PLATE=256: 7 parts, 7 materials =="; \
	if bake "G5/256" artifacts/logs/gate-v2-g5-256-bake.log COLOR=parts PLATE=256; then \
		check "G5/256" artifacts/chicago-parts-p256.3mf artifacts/logs/gate-v2-g5-256.log \
			'^parts +7:' '3mf_materials +PASS +7 entries' \
			'3mf_components +PASS +7 components, 7 distinct' \
			'3mf_objects +PASS +7 mesh \+ 1 assembly' \
			'3mf_color_mode +PASS' 'part_meshes +PASS' 'bodies +PASS +7 parts'; \
		check "G5/256 stl" artifacts/chicago-parts-p256.stl artifacts/logs/gate-v2-g5-256-stl.log \
			'bodies +PASS +1 '; \
	fi; \
	echo; echo "== gate-v2 [4/5] G6 TEXT=all: every ornament, lettering + base_floor PASS =="; \
	if bake "G6" artifacts/logs/gate-v2-g6-bake.log TEXT=all; then \
		check "G6" artifacts/chicago-text.3mf artifacts/logs/gate-v2-g6.log \
			'lettering +PASS +[1-9][0-9]* strokes of [1-9][0-9]* piece' 'base_floor +PASS' 'min_wall +PASS' \
			'3mf_attribution +PASS'; \
		check "G6 stl" artifacts/chicago-text.stl artifacts/logs/gate-v2-g6-stl.log \
			'bodies +PASS +1 ' 'lettering +PASS +[1-9][0-9]* strokes of [1-9][0-9]* piece' 'base_floor +PASS'; \
	fi; \
	echo; echo "== gate-v2 [5/5] COLOR=parts TEXT=all: the two composed =="; \
	if bake "parts+text" artifacts/logs/gate-v2-parts-text-bake.log COLOR=parts TEXT=all; then \
		check "parts+text" artifacts/chicago-parts-text.3mf artifacts/logs/gate-v2-parts-text.log \
			'^parts +[0-9]+:' 'lettering +PASS +[1-9][0-9]* strokes of [1-9][0-9]* piece' 'base_floor +PASS' \
			'3mf_components +PASS' '3mf_materials +PASS' 'part_meshes +PASS'; \
		check "parts+text stl" artifacts/chicago-parts-text.stl artifacts/logs/gate-v2-parts-text-stl.log \
			'bodies +PASS +1 ' 'lettering +PASS +[1-9][0-9]* strokes of [1-9][0-9]* piece'; \
	fi; \
	echo; \
	if [ $$rc -eq 0 ]; then echo "GATE-V2 PASS"; else echo "GATE-V2 FAIL" >&2; fi; \
	exit $$rc

# Bake the Chicago preset. Plain `make bake-fixture` is unchanged (single
# colour -> artifacts/chicago.3mf). Three optional overrides:
#   COLOR=parts   one 3MF object per layer -> artifacts/chicago-parts.3mf
#   PLATE=<mm>    plate size, 100..256 (the contract's own plate_mm range),
#                 honoured by all of them (256 makes trees printable). It takes
#                 a stem suffix like the other two: PLATE=256 writes
#                 chicago-p256.3mf, COLOR=parts PLATE=256 chicago-parts-p256.3mf.
#                 It used to change the PARAMETERS without changing the STEM, so
#                 `make bake-fixture PLATE=256` overwrote the default artifact
#                 with a 256 mm bake and the next `make validate
#                 artifacts/chicago.3mf` judged that against its own 256 mm
#                 sidecar and passed (v2-07 audit, finding 1).
#   TEXT=all      every v2 frame ornament -> artifacts/chicago-text.3mf:
#                 one engraving per edge (top {city} sans, bottom {coords} mono,
#                 left {scale} serif, right {date} sans EMBOSSED), the north
#                 arrow, an automatic scale bar, a keyhole hanger and the
#                 underside mark. Base 4 mm: a 2 mm keyhole plus the 0.6 mm road
#                 engraving needs 3.6 mm before the 1 mm floor rule is met, so a
#                 3 mm plate is refused (transform.underside_min_base_mm).
#                 Sizes are requested at the 8 mm maximum and auto-fitted down to
#                 the 6 mm lip, which is what exercises the fitting path.
# COLOR and TEXT compose (COLOR=parts TEXT=all -> chicago-parts-text.3mf).
# Everything ends up as a --params JSON object, so the sidecar records exactly
# what was baked and `make validate` judges the file against those parameters.
bake-fixture:
	@stem=chicago; fields=""; \
	case "$(COLOR)" in \
		""|single) ;; \
		parts) stem=chicago-parts; fields='"color_mode":"parts"' ;; \
		*) echo "make bake-fixture: COLOR must be 'single' or 'parts' (got '$(COLOR)')" >&2; exit 2 ;; \
	esac; \
	case "$(TEXT)" in \
		"") ;; \
		all) \
			case "$$stem" in chicago) stem=chicago-text ;; *) stem="$$stem-text" ;; esac; \
			if [ -n "$$fields" ]; then fields="$$fields,"; fi; \
			fields="$$fields\"city_label\":\"Chicago\",\"base_thickness_mm\":4.0"; \
			fields="$$fields,\"engravings\":["; \
			fields="$$fields{\"edge\":\"top\",\"text\":\"{city}\",\"size_mm\":8.0,\"font\":\"sans\"},"; \
			fields="$$fields{\"edge\":\"bottom\",\"text\":\"{coords}\",\"size_mm\":8.0,\"font\":\"mono\",\"align\":\"end\"},"; \
			fields="$$fields{\"edge\":\"left\",\"text\":\"{scale}\",\"size_mm\":8.0,\"font\":\"serif\"},"; \
			fields="$$fields{\"edge\":\"right\",\"text\":\"{date}\",\"size_mm\":8.0,\"font\":\"sans\",\"mode\":\"emboss\"}]"; \
			fields="$$fields,\"north_arrow\":{\"enabled\":true,\"corner\":\"ne\",\"size_mm\":4.0}"; \
			fields="$$fields,\"scale_bar\":{\"enabled\":true,\"edge\":\"bottom\",\"length_mode\":\"auto\"}"; \
			fields="$$fields,\"hanger\":\"keyhole\""; \
			fields="$$fields,\"underside_mark\":{\"enabled\":true,\"template\":\"{city} {scale} {date}\"}"; \
			;; \
		*) echo "make bake-fixture: TEXT must be 'all' (got '$(TEXT)')" >&2; exit 2 ;; \
	esac; \
	if [ -n "$(PLATE)" ]; then \
		case "$(PLATE)" in \
			*[!0-9.]*|*.*.*|.) echo "make bake-fixture: PLATE must be a number of millimetres (got '$(PLATE)')" >&2; exit 2 ;; \
		esac; \
		if ! awk -v v="$(PLATE)" 'BEGIN{exit !(v+0 >= 100 && v+0 <= 256)}' </dev/null; then \
			echo "make bake-fixture: PLATE must be between 100 and 256 mm (got '$(PLATE)')." >&2; \
			echo "                   That is print_params.json's own plate_mm range; outside it" >&2; \
			echo "                   the bake dies in a pydantic ValidationError minutes later." >&2; \
			exit 2; \
		fi; \
		stem="$$stem-p$$(echo "$(PLATE)" | tr . _)"; \
		if [ -n "$$fields" ]; then fields="$$fields,"; fi; \
		fields="$$fields\"plate_mm\":$(PLATE)"; \
	fi; \
	if [ -n "$$fields" ]; then set -- --params "{$$fields}"; else set --; fi; \
	echo "baking chicago-loop -> artifacts/$$stem.3mf $$*"; \
	cd services/bake && uv run python -m app.cli bake --preset chicago-loop --out "../../artifacts/$$stem.3mf" "$$@"

validate:
	@F="$(FILE)"; \
	if [ -z "$$F" ]; then F="$(filter-out validate,$(MAKECMDGOALS))"; fi; \
	if [ -z "$$F" ]; then echo "usage: make validate FILE=<path-from-repo-root>  (or: make validate <path>)" >&2; exit 1; fi; \
	case "$$F" in \
		/*|?:*) ABS="$$F" ;; \
		*) ABS="$$PWD/$$F" ;; \
	esac; \
	cd services/bake && uv run python -m app.cli validate "$$ABS"

refresh-fixtures:
	cd services/bake && uv run python -m app.cli refresh-fixtures

clean:
	rm -rf apps/web/.next
	rm -f artifacts/*.3mf artifacts/*.stl artifacts/*.json
	rm -rf .run
	rm -rf artifacts/logs

# Swallow extra positional args (e.g. `make validate artifacts/chicago.3mf`)
# so make does not fail with "No rule to make target ...". Scoped to the
# `validate` invocation only, so a mistyped target (`make gaet`) still errors
# instead of silently succeeding.
ifneq (,$(filter validate,$(MAKECMDGOALS)))
%:
	@:
endif
