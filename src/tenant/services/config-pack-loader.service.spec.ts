import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ConfigPackSchema,
  safeValidateConfigPack,
} from '../../../packages/config-packs/_schema/pack.schema';
import { ConfigPackLoaderService } from './config-pack-loader.service';
import { RuleEvaluatorService } from '../../rules/rule-evaluator.service';

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

  it('rejects a regulator that claims an adapter without naming one', () => {
    // The guard behind the availability field: "adapter" is a promise that
    // something resolvable exists, so it cannot be made without an adapterId.
    const base = {
      code: 'zz-immigration',
      name: 'Test pack',
      version: '1.0.0',
      vertical: 'immigration',
      country: 'ZZ',
      locales: ['en'],
    };

    const bad = safeValidateConfigPack({
      ...base,
      regulators: [
        { id: 'x', name: 'X', country: 'ZZ', availability: 'adapter' },
      ],
    });
    expect(bad.success).toBe(false);

    const good = safeValidateConfigPack({
      ...base,
      regulators: [
        { id: 'x', name: 'X', country: 'ZZ', availability: 'licence_required' },
      ],
    });
    expect(good.success).toBe(true);
  });

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
    '%s only references adapters that actually exist',
    (_label, file) => {
      const result = safeValidateConfigPack(
        JSON.parse(fs.readFileSync(file, 'utf-8')),
      );
      if (!result.success) throw new Error('pack did not validate');

      // Read the ids off the adapter classes rather than hardcoding a list, so
      // adding an adapter does not need this test edited.
      const adapterDir = path.resolve(__dirname, '../../integrations/adapters');
      const registered = new Set(
        fs
          .readdirSync(adapterDir)
          .filter((f) => f.endsWith('.adapter.ts'))
          .flatMap((f) => {
            const src = fs.readFileSync(path.join(adapterDir, f), 'utf-8');
            const m = /readonly adapterId = '([^']+)'/.exec(src);
            return m ? [m[1]] : [];
          }),
      );

      // Both packs shipped regulators pointing at adapters that did not exist
      // — `au-vevo`, `uae-cbuae`, `refinitiv-worldcheck`, `dowjones-rnc`,
      // `finacle-core`, `uae-local-sanctions`. A dangling adapterId is
      // invisible until something resolves the regulator, gets `undefined`, and
      // fails as a missing capability rather than as a broken reference.
      //
      // A regulator with no adapter is legitimate — WorldCheck cannot exist in
      // code until a contract is signed — but it must say so via `availability`
      // rather than by naming an adapter that isn't there.
      for (const regulator of result.data.regulators ?? []) {
        if (regulator.availability === 'adapter') {
          expect(registered).toContain(regulator.adapterId);
        } else {
          expect(regulator.adapterId).toBeUndefined();
        }
      }

      // Same hazard in workflow steps that call an adapter — and here it is
      // not latent: this one executes.
      for (const workflow of result.data.workflows ?? []) {
        for (const step of workflow.steps) {
          if (step.apiAction) {
            expect(registered).toContain(step.apiAction.adapterId);
          }
        }
      }
    },
  );

  it.each(files.map((f) => [path.basename(path.dirname(f)) + '/' + path.basename(f), f]))(
    '%s alert rules only reference things that exist',
    (_label, file) => {
      const result = safeValidateConfigPack(
        JSON.parse(fs.readFileSync(file, 'utf-8')),
      );
      if (!result.success) throw new Error('pack did not validate');

      const rules = result.data.alertRules ?? [];
      if (!rules.length) return;

      // Same class of defect as the dangling adapterIds: a rule that names a
      // role nobody holds, or a template that does not exist, fails at 3am
      // inside a sweep over a customer's records — and a rule that notifies
      // nobody is indistinguishable, from the outside, from a rule that never
      // matched.
      const roles = new Set((result.data.roles ?? []).map((r) => r.key));
      const templates = new Set(
        (result.data.messaging?.templates ?? []).map((t) => t.key),
      );

      // Read the entity types off the core enum rather than hardcoding them,
      // so adding one does not need this test edited. A rule scanning a type
      // core cannot store scans nothing, forever, silently.
      const entitySource = fs.readFileSync(
        path.resolve(__dirname, '../../crm/entities/universal-entity.entity.ts'),
        'utf-8',
      );
      const coreTypes = new Set(
        [...entitySource.matchAll(/^\s{2}[A-Z_]+ = '([a-z_]+)',$/gm)].map(
          (m) => m[1],
        ),
      );

      const ruleKeys = rules.map((r) => r.key);
      expect(new Set(ruleKeys).size).toBe(ruleKeys.length);

      for (const rule of rules) {
        expect(coreTypes).toContain(rule.entityType);

        for (const role of [
          ...(rule.notifyRoles ?? []),
          ...(rule.escalateToRoles ?? []),
        ]) {
          expect(roles).toContain(role);
        }

        if (rule.templateKey) expect(templates).toContain(rule.templateKey);

        // Escalating to nobody is a no-op that reads like a safety net.
        if (rule.escalateAfterHours !== null) {
          expect(rule.escalateToRoles.length).toBeGreaterThan(0);
        }
      }
    },
  );

  it.each(files.map((f) => [path.basename(path.dirname(f)) + '/' + path.basename(f), f]))(
    '%s alert rules compile under the evaluator that will run them',
    (_label, file) => {
      const result = safeValidateConfigPack(
        JSON.parse(fs.readFileSync(file, 'utf-8')),
      );
      if (!result.success) throw new Error('pack did not validate');

      // The pack schema types `when` as unknown — it has to, JsonLogic is
      // recursive and open-ended. So the only thing standing between a typo
      // and a rule that silently never matches is this: compile every
      // authored rule with the same evaluator the sweep uses.
      const evaluator = new RuleEvaluatorService();
      for (const rule of result.data.alertRules ?? []) {
        const check = evaluator.validate(rule.when);
        if (!check.valid) {
          throw new Error(`alertRules.${rule.key}: ${check.reason}`);
        }
      }
    },
  );

  it.each(files.map((f) => [path.basename(path.dirname(f)) + '/' + path.basename(f), f]))(
    '%s relationships link entity types core can actually store',
    (_label, file) => {
      const result = safeValidateConfigPack(
        JSON.parse(fs.readFileSync(file, 'utf-8')),
      );
      if (!result.success) throw new Error('pack did not validate');

      const relationships = result.data.relationships ?? [];
      if (!relationships.length) return;

      const entitySource = fs.readFileSync(
        path.resolve(__dirname, '../../crm/entities/universal-entity.entity.ts'),
        'utf-8',
      );
      const coreTypes = new Set(
        [...entitySource.matchAll(/^\s{2}[A-Z_]+ = '([a-z_]+)',$/gm)].map(
          (m) => m[1],
        ),
      );
      // Types with no lifecycle can never be "still open", so a blocking
      // relation pointing at one blocks nothing — it reads like a dependency
      // and behaves like a note.
      const workable = new Set([
        'case',
        'obligation',
        'breach',
        'lead',
        'vendor',
        'control_test',
        'risk_scenario',
        'milestone',
        'rfi',
        'screening_match',
      ]);

      const keys = relationships.map((r) => r.key);
      expect(new Set(keys).size).toBe(keys.length);

      for (const relation of relationships) {
        expect(coreTypes).toContain(relation.fromType);
        expect(coreTypes).toContain(relation.toType);
        if (relation.blocksCompletion) {
          expect(workable).toContain(relation.toType);
        }
      }
    },
  );

  it.each(files.map((f) => [path.basename(path.dirname(f)) + '/' + path.basename(f), f]))(
    '%s scoring models produce a band for every reachable score',
    (_label, file) => {
      const result = safeValidateConfigPack(
        JSON.parse(fs.readFileSync(file, 'utf-8')),
      );
      if (!result.success) throw new Error('pack did not validate');

      const models = result.data.scoringModels ?? [];
      if (!models.length) return;

      const evaluator = new RuleEvaluatorService();

      for (const model of models) {
        for (const factor of model.factors) {
          const check = evaluator.validate(factor.when);
          if (!check.valid) {
            throw new Error(
              `scoringModels.${model.key}.${factor.key}: ${check.reason}`,
            );
          }
        }

        if (!model.bands.length) continue;

        // A record that matches nothing still gets a score — the floor, which
        // is zero when every weight is positive and negative when penalties
        // exist. A band set that does not cover it leaves the commonest case
        // (a brand-new record) unbanded, which reads in a UI as broken.
        const floor = model.factors
          .filter((f) => f.weight < 0)
          .reduce((sum, f) => sum + f.weight, 0);
        const lowest = Math.min(...model.bands.map((b) => b.minScore));
        expect(lowest).toBeLessThanOrEqual(floor);

        const bandKeys = model.bands.map((b) => b.key);
        expect(new Set(bandKeys).size).toBe(bandKeys.length);
      }
    },
  );

  it.each(files.map((f) => [path.basename(path.dirname(f)) + '/' + path.basename(f), f]))(
    '%s fees and payment plans are chargeable as authored',
    (_label, file) => {
      const result = safeValidateConfigPack(
        JSON.parse(fs.readFileSync(file, 'utf-8')),
      );
      if (!result.success) throw new Error('pack did not validate');

      const fees = result.data.fees ?? [];
      const plans = result.data.paymentPlans ?? [];
      if (!fees.length && !plans.length) return;

      // Every step id the pack's workflows actually define. A fee or a stage
      // pinned to a step that does not exist is never collected and never
      // gates anything — the same dangling-reference class as the adapter ids.
      const steps = new Set(
        (result.data.workflows ?? []).flatMap((w) => w.steps.map((s) => s.id)),
      );

      const feeKeys = fees.map((f) => f.key);
      expect(new Set(feeKeys).size).toBe(feeKeys.length);

      for (const fee of fees) {
        expect(fee.currency).toMatch(/^[A-Z]{3}$/);
        // Money is minor units and integral. A fractional cent in a regulated
        // ledger is a reportable incident, not a rounding preference.
        expect(Number.isInteger(fee.amountMinor)).toBe(true);
        if (fee.atStep) expect(steps).toContain(fee.atStep);
        // A government charge that is refundable is almost always an
        // authoring slip — regulators do not refund lodgement fees.
        if (fee.kind === 'government') expect(fee.refundable).toBe(false);
      }

      for (const plan of plans) {
        if (plan.type !== 'stage_gated') continue;

        expect(plan.stages.length).toBeGreaterThan(0);
        const total = plan.stages.reduce((sum, s) => sum + s.portionBps, 0);
        // The expander refuses these at runtime; catching it here means a
        // pack author finds out at review rather than a client finds out from
        // an invoice for 90% of the fee.
        expect(total).toBe(10_000);

        for (const stage of plan.stages) expect(steps).toContain(stage.atStep);
      }
    },
  );

  it.each(files.map((f) => [path.basename(path.dirname(f)) + '/' + path.basename(f), f]))(
    '%s messaging sequences only reference templates that exist, and can stop',
    (_label, file) => {
      const result = safeValidateConfigPack(
        JSON.parse(fs.readFileSync(file, 'utf-8')),
      );
      if (!result.success) throw new Error('pack did not validate');

      const sequences = result.data.messaging?.sequences ?? [];
      if (!sequences.length) return;

      const templates = new Map(
        (result.data.messaging?.templates ?? []).map((t) => [t.key, t]),
      );
      const evaluator = new RuleEvaluatorService();

      // Everything the sequence runner can put in a template. A template that
      // declares more than this sends a client a literal `{{uploadUrl}}` —
      // the runner reports it, but reporting it after delivery is late.
      const supplied = new Set([
        'firstName',
        'lastName',
        'firmName',
        'entityId',
        'entityType',
        'dueDate',
      ]);

      for (const sequence of sequences) {
        expect(evaluator.validate(sequence.trigger.when).valid).toBe(true);
        if (sequence.stopWhen) {
          // The dangerous one: a sequence with an uncompilable stop condition
          // enrols correctly and then never stops.
          expect(evaluator.validate(sequence.stopWhen).valid).toBe(true);
        }

        for (const step of sequence.steps) {
          const template = templates.get(step.templateKey);
          expect(template).toBeDefined();
          for (const variable of template!.variables) {
            expect(supplied).toContain(variable);
          }
          if (step.when) {
            expect(evaluator.validate(step.when).valid).toBe(true);
          }
        }
      }
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

/**
 * The behavioural half of the parity guard: a pack carrying every Layer 4
 * section is loaded through the real loader and the persisted row is inspected.
 *
 * The source-text test above catches a *missing key*. This one catches the
 * subtler version of the same bug — a key that is present but arrives empty, or
 * a nested block that is flattened on the way through. `entityTypes` was
 * stripped twice (e8758da) and neither strip was an error; the pack loaded
 * cleanly and the section simply was not there afterwards.
 *
 * No database: the repository is a stub and `runAsSystem` is AsyncLocalStorage
 * only, so what is asserted is exactly the object the loader hands to TypeORM.
 */
describe('a pack with every section survives load → persisted row', () => {
  // Deliberately terse but *non-empty* everywhere: the failure being defended
  // against turns a populated section into `[]`, which an emptiness check
  // would not notice.
  const fullPack = {
    code: 'zz-immigration',
    name: 'Round-trip test pack',
    version: '9.9.9',
    vertical: 'immigration',
    country: 'ZZ',
    locales: ['en'],
    roles: [{ key: 'agent', label: 'Agent', permissions: ['case:read'] }],
    documentTypes: [
      { key: 'passport', label: 'Passport', acceptedFormats: ['pdf', 'jpg'] },
    ],
    entityTypes: [{ type: 'case', label: 'Case', pluralLabel: 'Cases' }],
    kpis: [{ key: 'open_cases', label: 'Open cases', unit: 'count' }],
    prompts: [
      {
        key: 'summarise',
        category: 'entity_analysis',
        prompt: 'Summarise the following entity for a case officer: {{INPUT}}',
        isCategoryDefault: true,
      },
    ],
    messaging: {
      templates: [
        {
          key: 'welcome',
          name: 'Welcome',
          channel: 'email',
          subject: 'Hello {{name}}',
          body: 'Hello {{name}}',
          variables: ['name'],
        },
      ],
      sequences: [
        {
          key: 'chase_docs',
          label: 'Chase documents',
          trigger: { entityType: 'case', when: { var: 'awaitingDocuments' } },
          steps: [{ templateKey: 'welcome', afterHours: 24 }],
        },
      ],
    },
    rules: [
      { key: 'is_minor', label: 'Applicant is a minor', when: { '<': [{ var: 'age' }, 18] } },
    ],
    alertRules: [
      {
        key: 'visa_expiring',
        label: 'Visa expiring',
        entityType: 'case',
        when: { '<': [{ var: 'visaExpiry_daysUntil' }, 30] },
      },
    ],
    fees: [
      {
        key: 'gov_482',
        label: 'Subclass 482 charge',
        kind: 'government',
        amountMinor: 130000,
        currency: 'AUD',
      },
    ],
    paymentPlans: [{ key: 'upfront', label: 'Pay upfront', type: 'upfront' }],
    scoringModels: [
      {
        key: 'lead_score',
        label: 'Lead score',
        entityType: 'lead',
        factors: [
          { key: 'has_sponsor', label: 'Has sponsor', when: { var: 'sponsorId' }, weight: 10 },
        ],
      },
    ],
    relationships: [
      {
        key: 'blocks',
        label: 'Blocks',
        fromType: 'task',
        toType: 'task',
        blocksCompletion: true,
      },
    ],
    navigation: [{ key: 'cases', label: 'Cases', path: '/cases' }],
    dashboards: [
      {
        key: 'staff_home',
        label: 'Staff home',
        widgets: [
          { key: 'open', label: 'Open', type: 'count', source: 'case' },
        ],
      },
    ],
    importMappings: [
      {
        key: 'leads_csv',
        label: 'Leads CSV',
        source: 'csv',
        targetEntityType: 'lead',
        fields: [{ from: 'Email', to: 'email', required: true }],
      },
    ],
  };

  let saved: Record<string, any> | undefined;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meru-packs-'));
    fs.mkdirSync(path.join(tmpDir, 'zz'));
    fs.writeFileSync(
      path.join(tmpDir, 'zz', 'immigration.json'),
      JSON.stringify(fullPack),
    );

    const repo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x: Record<string, any>) => x),
      save: jest.fn((x: Record<string, any>) => {
        saved = x;
        return Promise.resolve(x);
      }),
    };

    const service = new ConfigPackLoaderService(repo as any);
    // The directory is resolved at construction from a fixed candidate list;
    // this is the only seam for pointing it at a fixture.
    (service as unknown as { packsDir: string }).packsDir = tmpDir;

    const report = await service.reload();
    // If the pack failed validation the loader skips it and logs — which is the
    // silent mode this whole file exists to make loud.
    expect(report.errors).toEqual([]);
    expect(report.inserted).toBe(1);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const arrays = [
    'roles',
    'documentTypes',
    'entityTypes',
    'kpis',
    'prompts',
    'rules',
    'alertRules',
    'fees',
    'paymentPlans',
    'scoringModels',
    'relationships',
    'navigation',
    'dashboards',
    'importMappings',
  ];

  it.each(arrays)('persists a non-empty "%s"', (key) => {
    expect(saved?.schema?.[key]).toHaveLength(1);
  });

  it('persists messaging templates and sequences', () => {
    expect(saved?.schema?.messaging?.templates).toHaveLength(1);
    expect(saved?.schema?.messaging?.sequences).toHaveLength(1);
  });

  it('keeps json-logic conditions intact rather than stringifying them', () => {
    // A `when` is `z.unknown()`, so nothing in the schema would object if it
    // arrived as "[object Object]". The evaluators cannot compile that.
    expect(saved?.schema?.alertRules?.[0].when).toEqual({
      '<': [{ var: 'visaExpiry_daysUntil' }, 30],
    });
    expect(saved?.schema?.rules?.[0].when).toEqual({ '<': [{ var: 'age' }, 18] });
  });

  it('applies schema defaults on the way through', () => {
    // Defaults are applied by Zod at parse time, so an author who omits
    // `cooldownHours` still gets one rather than `undefined` reaching a job
    // that multiplies by it.
    expect(saved?.schema?.alertRules?.[0].cooldownHours).toBe(24);
    expect(saved?.schema?.alertRules?.[0].severity).toBe('warning');
    expect(saved?.schema?.fees?.[0].basis).toBe('per_case');
  });
});
