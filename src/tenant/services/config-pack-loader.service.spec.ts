import * as fs from 'fs';
import * as path from 'path';
import {
  ConfigPackSchema,
  safeValidateConfigPack,
} from '../../../packages/config-packs/_schema/pack.schema';

/**
 * The guard against this repo's most repeated config-pack failure: a section is
 * added to the Zod schema, validates fine, and is then dropped on the way to the
 * database because nobody added it to the loader's `schema:` key list. It
 * happened to `entityTypes` (e8758da) and it is invisible — the pack loads
 * without an error and the section simply does not exist at runtime.
 *
 * So this test reads the loader's own source and asserts that every optional
 * top-level section in the Zod schema is named in it. It is a source-text
 * assertion rather than a behavioural one on purpose: instantiating the loader
 * needs a database, and the failure being defended against is a missing line of
 * code, which is exactly what a source assertion catches.
 */
describe('config pack schema ↔ loader parity', () => {
  const loaderSource = fs.readFileSync(
    path.resolve(__dirname, 'config-pack-loader.service.ts'),
    'utf-8',
  );

  // Keys the loader stores outside `schema` (they are columns on the entity) or
  // that it deliberately does not persist.
  const notInSchemaBlob = new Set([
    'code',
    'name',
    'description',
    'version',
    'vertical',
    'defaults',
    'uiConfig',
  ]);

  const sectionKeys = Object.keys(ConfigPackSchema.shape).filter(
    (k) => !notInSchemaBlob.has(k),
  );

  it.each(sectionKeys)(
    'loader persists the "%s" section',
    (key) => {
      // Matches `key: def.key ?? …` in the packData `schema` block.
      expect(loaderSource).toMatch(new RegExp(`\\b${key}:\\s*def\\.${key}\\b`));
    },
  );

  it('has at least the sections the modules read at runtime', () => {
    // Named explicitly so deleting one from the Zod schema fails here rather
    // than silently reducing the it.each list to nothing.
    expect(sectionKeys).toEqual(
      expect.arrayContaining([
        'documentTypes',
        'entityTypes',
        'workflows',
        'prompts',
        'messaging',
      ]),
    );
  });
});

/**
 * Every pack on disk must validate. A pack that fails validation is skipped by
 * the loader with a logged error, which on a cold serverless boot nobody reads —
 * the observable symptom is a feature quietly having no configuration.
 */
describe('packs on disk', () => {
  const packsDir = path.resolve(__dirname, '../../../packages/config-packs');

  const files: string[] = [];
  for (const entry of fs.readdirSync(packsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('_')) {
      for (const file of fs.readdirSync(path.join(packsDir, entry.name))) {
        if (file.endsWith('.json')) {
          files.push(path.join(packsDir, entry.name, file));
        }
      }
    }
  }

  it('found packs to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [path.basename(path.dirname(f)) + '/' + path.basename(f), f]))(
    '%s validates',
    (_label, file) => {
      const result = safeValidateConfigPack(
        JSON.parse(fs.readFileSync(file, 'utf-8')),
      );
      if (!result.success) {
        throw new Error(
          result.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        );
      }
      expect(result.success).toBe(true);
    },
  );

  it.each(files.map((f) => [path.basename(path.dirname(f)) + '/' + path.basename(f), f]))(
    '%s ships a prompt library with one default per category',
    (_label, file) => {
      const result = safeValidateConfigPack(
        JSON.parse(fs.readFileSync(file, 'utf-8')),
      );
      if (!result.success) throw new Error('pack did not validate');

      const prompts = result.data.prompts ?? [];
      // A pack with no prompts is what made /ai/execute answer 500 for every
      // tenant. Every pack must carry a library.
      expect(prompts.length).toBeGreaterThan(0);

      const defaultsByCategory = new Map<string, number>();
      for (const p of prompts) {
        if (p.isCategoryDefault) {
          defaultsByCategory.set(
            p.category,
            (defaultsByCategory.get(p.category) ?? 0) + 1,
          );
        }
      }
      // Two defaults in one category makes the resolver's choice arbitrary.
      for (const [category, count] of defaultsByCategory) {
        expect(count).toBe(1);
      }

      const keys = prompts.map((p) => p.key);
      expect(new Set(keys).size).toBe(keys.length);
    },
  );

  it.each(files.map((f) => [path.basename(path.dirname(f)) + '/' + path.basename(f), f]))(
    '%s ships message templates with unique keys and declared variables',
    (_label, file) => {
      const result = safeValidateConfigPack(
        JSON.parse(fs.readFileSync(file, 'utf-8')),
      );
      if (!result.success) throw new Error('pack did not validate');

      const templates = result.data.messaging?.templates ?? [];
      expect(templates.length).toBeGreaterThan(0);

      const keys = templates.map((t) => t.key);
      expect(new Set(keys).size).toBe(keys.length);

      for (const t of templates) {
        // Every `{{placeholder}}` actually used must be declared, or a caller
        // has no way to know what to pass and the recipient gets a literal
        // `{{firstName}}`.
        const used = new Set(
          [...`${t.subject}\n${t.body}`.matchAll(/{{(\w+)}}/g)].map(
            (m) => m[1],
          ),
        );
        for (const name of used) {
          expect(t.variables).toContain(name);
        }
      }
    },
  );
});
