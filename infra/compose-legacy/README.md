## compose-legacy/

Historical docker-compose files preserved as reference, **not used by the
local-dev workflow**.

- `docker-compose.all-verticals.yml` — single-file orchestration that ran 9
  containers (meru / immigration / grc × dev / staging / prod). Replaced by
  per-tenant runtime config; production targets k8s per CLAUDE.md §8.
- `docker-compose.{meru,immigration,grc}.yml` — vertical-specific
  EC2-deployment templates. The `VERTICAL` env variable now drives the same
  behavior at runtime; no need for separate compose files per vertical.

For local dev, use the canonical `docker-compose.yml` at the repo root.
For production, see `infra/terraform/` and `k8s/` (target state).
