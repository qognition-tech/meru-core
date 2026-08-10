# Meru Core

The **Regulatory Operating System** API — 14 horizontal modules and 4 specialist
engines, with vertical and country behaviour injected as JSON config packs.

- **Live:** https://meru-core.vercel.app · API `/api/v1` · Swagger `/api` · spec `/api-json`
- **Architecture, rules and operations:** [CLAUDE.md](CLAUDE.md)
- **Current state, gaps and what to build next:** [AGENTS.md](AGENTS.md)

These two documents are the entire documentation surface. There is no third
place to put it — keep them current in the same commit as the change.

```bash
npm install
node scripts/provision-rls-role.js --write-env   # create the non-BYPASSRLS app role
npm run migration:run
npm run rls:verify                               # prove tenant isolation holds
npm start                                        # PORT=8000
```
