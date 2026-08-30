SHELL := sh
.DEFAULT_GOAL := help
.PHONY: help install contracts up dev down test gate bake-fixture validate refresh-fixtures clean

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
	@echo "  gate              G4: pytest + lint + tsc + vitest + next build + playwright smoke (stack up/down)"
	@echo "  bake-fixture      bake the Chicago preset to artifacts/chicago.3mf"
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

down:
	@if docker compose version >/dev/null 2>&1 && [ -f docker-compose.yml ]; then \
		docker compose down; \
	fi
	@for name in bake web; do \
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
	done

test:
	cd services/bake && uv run pytest -q
	cd apps/web && npm test

# G4. Runs everything, in order, and never leaves the stack up:
#   1. pytest            (services/bake)
#   2. lint + typecheck + vitest + next build   (apps/web)
#   3. make up -> playwright smoke test -> make down (down even on failure)
#   4. the teardown is CHECKED: a failing `make down`, or a port still
#      listening after it, fails the gate. "never leaves the stack up" is an
#      assertion, not a hope - a survivor holds :8000/:3000 and makes the next
#      `make up` a hard error (DECISIONS [P1-fix]).
# Exits non-zero if ANY step failed. `next build` deliberately runs BEFORE
# `make up`: building into .next while `next dev` is serving it corrupts the
# dev server (DECISIONS [P4]).
gate:
	@rc=0; \
	mkdir -p artifacts/logs; \
	port_listening() { \
		netstat -ano 2>/dev/null | grep LISTENING | grep -q ":$$1 " && return 0; \
		curl -sf -o /dev/null --max-time 5 "http://localhost:$$1/" && return 0; \
		curl -sf -o /dev/null --max-time 5 "http://localhost:$$1/health" && return 0; \
		return 1; \
	}; \
	echo "== gate [0/5] stopping any running stack (the gate owns the lifecycle) =="; \
	$(MAKE) down > artifacts/logs/down.log 2>&1 || true; \
	echo "== gate [1/5] pytest (services/bake) =="; \
	( cd services/bake && uv run pytest -q ) || { echo "gate: pytest FAILED" >&2; rc=1; }; \
	echo "== gate [2/5] lint + typecheck + vitest + next build (apps/web) =="; \
	( cd apps/web && npm run lint && npm run typecheck && npm test && npm run build ) \
		|| { echo "gate: apps/web lint/typecheck/vitest/build FAILED" >&2; rc=1; }; \
	if [ $$rc -ne 0 ]; then \
		echo "gate: skipping the Playwright smoke test after an earlier failure" >&2; \
	else \
		echo "== gate [3/5] playwright chromium =="; \
		if ( cd apps/web && node -e "const{chromium}=require('@playwright/test');if(!require('fs').existsSync(chromium.executablePath()))process.exit(1)" ) 2>/dev/null; then \
			echo "chromium is installed"; \
			echo "== gate [4/5] make up + playwright smoke test =="; \
			rm -f artifacts/e2e/results.json; \
			if FRAMECRAFT_OFFLINE= $(MAKE) up > artifacts/logs/up.log 2>&1; then \
				( cd apps/web && npm run test:e2e ) || { echo "gate: playwright smoke test FAILED" >&2; rc=1; }; \
				node -e "const r=require('./artifacts/e2e/results.json');const s=(r.stats||{}).skipped||0;if(s){console.error('gate: '+s+' Playwright test(s) SKIPPED - the gate does not accept a skipped acceptance test');process.exit(1)}" \
					|| { echo "gate: playwright reported skipped test(s) (see artifacts/e2e/results.json)" >&2; rc=1; }; \
			else \
				echo "gate: make up FAILED (see artifacts/logs/up.log)" >&2; \
				tail -20 artifacts/logs/up.log >&2 || true; \
				rc=1; \
			fi; \
			echo "== gate [5/5] teardown (always attempted, and checked) =="; \
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
		else \
			echo "gate: Playwright's chromium is not installed." >&2; \
			echo "      run: cd apps/web && npx playwright install chromium   (or: make install)" >&2; \
			rc=1; \
		fi; \
	fi; \
	if [ $$rc -eq 0 ]; then echo "GATE PASS"; else echo "GATE FAIL" >&2; fi; \
	exit $$rc

bake-fixture:
	cd services/bake && uv run python -m app.cli bake --preset chicago-loop --out ../../artifacts/chicago.3mf

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
