## infra/

Provisioning and operational shell scripts from an earlier bare-metal deployment plan. **Not
part of the build, and not part of how this repo actually deploys.**

- `setup-enterprise.sh` — one-shot bootstrap for a self-hosted stack (database, services, env
  wiring). Historical; not exercised by any current workflow.
- `user-data.sh` — EC2 cloud-init / user-data script for a baseline VM. Same status.

**Corrected 2026-09-05: there is no terraform anywhere in this repo, and none is planned.**
An earlier version of this file pointed at `infra/terraform/` as a "target state" — that
directory does not exist and never has. **Vercel CLI (`vercel deploy --prod`) is the only
deploy path this product has**; see `CLAUDE.md` §8. `docker-compose.yml`, `Dockerfile`,
`fly.toml`, `render.yaml`, `k8s/` and `grafana/`/`prometheus.yml` at the repo root are the
same kind of artefact as this folder — legacy, kept for reference, not deleted, not wired
into any deploy or monitoring path today. Do not scope work from any of them, and do not
delete the folders without asking — they may still be useful if this product ever leaves
serverless.
