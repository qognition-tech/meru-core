## infra/

Provisioning and operational shell scripts. Not part of the build.

- `setup-enterprise.sh` — one-shot bootstrap for the full enterprise stack
  (database, services, env wiring). Use only on a fresh host.
- `user-data.sh` — EC2 cloud-init / user-data script for spinning up a
  baseline VM with prerequisites.

Long-term, these should be replaced by terraform + GitHub Actions per
CLAUDE.md §8 (target infra). For now they cover the bare-metal path.
