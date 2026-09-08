## compose-legacy/

Historical docker-compose files from an earlier self-hosted deployment plan. **Not used by
local dev, not used by any deploy path, and not a "target state" for anything.**

- `docker-compose.all-verticals.yml` — single-file orchestration that ran 9 containers
  (meru / immigration / grc × dev / staging / prod). Superseded by per-tenant runtime config
  driven by the `VERTICAL` env var.
- `docker-compose.{meru,immigration,grc}.yml` — vertical-specific EC2-deployment templates.
  Same status.

**Corrected 2026-09-05: this repo has no k8s deploy path and no terraform.** An earlier
version of this file pointed at `infra/terraform/` and `k8s/` as "target state" for
production — neither is built out, wired to a pipeline, or planned as the near-term deploy
target. **Vercel CLI is the only deploy path** (`CLAUDE.md` §8) — `vercel deploy --prod --yes
--scope qognitionagencys-projects`, and pushing to GitHub does not deploy anything. The
`docker-compose.yml` and `Dockerfile` at the repo root, and the `k8s/` and `grafana/` folders,
are the same class of legacy artefact as the files in this folder — kept for reference, not
deleted, not part of how this product ships today.
