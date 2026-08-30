# Build context is the repo root (see docker-compose.yml) because this
# service needs its sibling packages/contracts and fixtures directories.
FROM python:3.12-slim

RUN pip install --no-cache-dir uv

WORKDIR /app

COPY services/bake/pyproject.toml services/bake/uv.lock services/bake/.python-version ./services/bake/
RUN cd services/bake && uv sync --frozen --no-install-project

COPY services/bake/app ./services/bake/app
COPY packages/contracts ./packages/contracts
COPY fixtures ./fixtures

RUN cd services/bake && uv sync --frozen

# Kept at the repo-root-equivalent depth (/app/services/bake/app/main.py) so
# app.main.REPO_ROOT (parents[3] of this file) resolves to /app, matching
# the ./artifacts and ./fixtures volumes mounted below in docker-compose.yml.
WORKDIR /app/services/bake

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
