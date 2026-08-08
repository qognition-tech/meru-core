/**
 * Regenerates `packages/config-packs/_schema/config-pack.schema.json` from the
 * Zod schema. Run with `npm run packs:schema`.
 *
 * Why generate rather than maintain: the two schemas had already diverged. The
 * hand-written JSON Schema still described `visaCategories`,
 * `documentRequirements`, `complianceDomains` and `features` — none of which
 * the Zod schema has accepted for a long time — while omitting
 * `documentTypes`, `entityTypes`, `screening`, `compliance`, `kpis` and
 * `locales`, all of which packs on disk actually use. Nothing read the JSON
 * file, so the drift was invisible.
 *
 * That divergence is not cosmetic. The last time these two disagreed about the
 * `code` pattern (slash vs hyphen), every pack was rejected at boot and
 * `config_packs` sat empty while the docs reported Layer 3/4 as live. One
 * generated artefact removes the whole class of failure: the JSON Schema is
 * for editor completion and external pack authors, and Zod stays the single
 * source of truth.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { ConfigPackSchema } from '../packages/config-packs/_schema/pack.schema';

const target = path.resolve(
  __dirname,
  '../packages/config-packs/_schema/config-pack.schema.json',
);

const generated = z.toJSONSchema(ConfigPackSchema, { io: 'input' }) as Record<
  string,
  unknown
>;

const document: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://meru.dev/config-pack.schema.json',
  title: 'Meru Config Pack',
  description:
    'GENERATED FILE — do not edit. Produced from packages/config-packs/_schema/pack.schema.ts by `npm run packs:schema`. Zod is the source of truth; edit that file and regenerate.',
  ...generated,
};

fs.writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);

const propertyCount = Object.keys(
  (document.properties ?? {}) as Record<string, unknown>,
).length;
console.log(
  `Wrote ${path.relative(process.cwd(), target)} — ${propertyCount} top-level properties`,
);
