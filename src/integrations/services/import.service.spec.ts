import { ImportService } from './import.service';

/**
 * The point of this pipeline is that it does not write until a human has seen
 * the diff, so most of these tests assert what it *declines* to do.
 */
describe('ImportService', () => {
  const mapping = {
    key: 'leads_csv',
    label: 'Leads',
    source: 'csv' as const,
    targetEntityType: 'lead',
    fields: [
      { from: 'First Name', to: 'firstName', required: true },
      { from: 'Email', to: 'email', required: true, transform: 'lowercase' as const },
      { from: 'Visa Expiry', to: 'visaExpiry', transform: 'date_iso' as const },
      { from: 'Phone', to: 'phoneNumber', transform: 'phone_e164' as const },
    ],
    dedupeOn: ['email'],
  };

  const existing = { id: 'existing-1', verticalAttributes: { note: 'keep me' } };
  let matchEmail: string | null = null;

  const entities = {
    createQueryBuilder: jest.fn(() => {
      const qb: any = {
        where: () => qb,
        andWhere: (_sql: string, params: Record<string, unknown>) => {
          if (params && Object.values(params).includes(matchEmail)) qb._hit = true;
          return qb;
        },
        getOne: () => Promise.resolve(qb._hit ? existing : null),
      };
      return qb;
    }),
    findOne: jest.fn().mockResolvedValue(existing),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    create: jest.fn((x: unknown) => x),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
  };

  const packs = { list: jest.fn().mockResolvedValue([mapping]) };
  const service = new ImportService(entities as any, packs as any);

  beforeEach(() => {
    matchEmail = null;
    entities.update.mockClear();
    entities.save.mockClear();
  });

  const csv = [
    'First Name,Email,Visa Expiry,Phone,Notes',
    'Ada,ADA@Example.com,03/06/2026,(050) 123 4567,hello',
    ',missing@example.com,,,',
  ].join('\n');

  it('writes nothing by default', async () => {
    const plan = await service.run('t1', 'immigration', 'leads_csv', csv);
    expect(plan.dryRun).toBe(true);
    expect(plan.committed).toBeUndefined();
    expect(entities.save).not.toHaveBeenCalled();
    expect(entities.update).not.toHaveBeenCalled();
  });

  it('skips a row missing a required field and says which one', async () => {
    const plan = await service.run('t1', 'immigration', 'leads_csv', csv);
    const bad = plan.rows.find((r) => r.action === 'skip')!;
    expect(bad.row).toBe(3); // header is line 1
    expect(bad.errors[0]).toMatch(/'First Name' is required/);
  });

  it('reads a day-first date as day-first', async () => {
    // 03/06/2026 from a UK or AU export is 3 June. `new Date()` reads it as
    // 6 March — a nine-week error in a visa expiry, silently.
    const plan = await service.run('t1', 'immigration', 'leads_csv', csv);
    expect(plan.rows[0].values.visaExpiry).toBe('2026-06-03');
  });

  it('applies the declared transforms', async () => {
    const plan = await service.run('t1', 'immigration', 'leads_csv', csv);
    expect(plan.rows[0].values.email).toBe('ada@example.com');
    expect(plan.rows[0].values.phoneNumber).toBe('+0501234567');
  });

  it('names columns nobody mapped', async () => {
    const plan = await service.run('t1', 'immigration', 'leads_csv', csv);
    // An unmapped column is usually one somebody expected to be imported.
    expect(plan.unmappedColumns).toEqual(['Notes']);
  });

  it('plans an update when a dedupe key matches, not a second copy', async () => {
    matchEmail = 'ada@example.com';
    const plan = await service.run('t1', 'immigration', 'leads_csv', csv);
    expect(plan.rows[0]).toMatchObject({ action: 'update', matchedId: 'existing-1' });
    expect(plan.updates).toBe(1);
  });

  it('merges vertical attributes on update rather than replacing them', async () => {
    matchEmail = 'ada@example.com';
    await service.run('t1', 'immigration', 'leads_csv', csv, { commit: true });
    const [, patch] = entities.update.mock.calls[0];
    // A three-column import must not erase the twenty fields it says nothing
    // about.
    expect(patch.verticalAttributes).toMatchObject({ note: 'keep me' });
  });

  it('rejects a mapping the pack does not declare, and lists what it does', async () => {
    await expect(
      service.run('t1', 'immigration', 'nope', csv),
    ).rejects.toThrow(/This vertical declares: leads_csv/);
  });

  it('parses quoted fields containing commas and newlines', () => {
    const rows = ImportService.parseCsv(
      'a,b\n"one, two","line1\nline2"\n',
    );
    // Splitting on newlines would shift every subsequent row by one and the
    // import would look like it worked.
    expect(rows[1]).toEqual(['one, two', 'line1\nline2']);
    expect(rows).toHaveLength(2);
  });
});

/**
 * XLSX goes through the same parse → map → dry-run → commit pipeline as CSV;
 * only the parser differs. These tests build a real workbook with exceljs
 * and assert the plan is the one the CSV tests above would produce.
 */
describe('ImportService — xlsx', () => {
  const ExcelJS = require('exceljs');

  const mapping = {
    key: 'leads_xlsx',
    label: 'Leads (Excel)',
    source: 'xlsx' as const,
    targetEntityType: 'lead',
    fields: [
      { from: 'First Name', to: 'firstName', required: true },
      { from: 'Email', to: 'email', required: true, transform: 'lowercase' as const },
      { from: 'Visa Expiry', to: 'visaExpiry', transform: 'date_iso' as const },
    ],
    dedupeOn: ['email'],
  };

  const entities = {
    createQueryBuilder: jest.fn(() => {
      const qb: any = { where: () => qb, andWhere: () => qb, getOne: () => Promise.resolve(null) };
      return qb;
    }),
    create: jest.fn((x: unknown) => x),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
    update: jest.fn(),
  };
  const packs = { list: jest.fn().mockResolvedValue([mapping]) };
  const service = new ImportService(entities as any, packs as any);

  const workbook = async (rows: unknown[][]): Promise<Buffer> => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Leads');
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  };

  it('parses the first sheet into the same plan a CSV would give', async () => {
    const content = await workbook([
      ['First Name', 'Email', 'Visa Expiry', 'Notes'],
      ['Ada', 'ADA@Example.com', new Date(Date.UTC(2026, 5, 3)), 'hello'],
      ['', 'missing@example.com', null, ''],
    ]);
    const plan = await service.run('t1', 'immigration', 'leads_xlsx', {
      format: 'xlsx',
      content,
    });
    expect(plan.dryRun).toBe(true);
    expect(plan.totalRows).toBe(2);
    expect(plan.rows[0]).toMatchObject({
      action: 'create',
      values: { firstName: 'Ada', email: 'ada@example.com', visaExpiry: '2026-06-03' },
    });
    expect(plan.rows[1].row).toBe(3);
    expect(plan.rows[1].errors[0]).toMatch(/'First Name' is required/);
    expect(plan.unmappedColumns).toEqual(['Notes']);
    expect(entities.save).not.toHaveBeenCalled();
  });

  it('reads a formula cell as its cached result and rich text as plain text', async () => {
    const content = await workbook([
      ['First Name', 'Email', 'Visa Expiry'],
      [
        { richText: [{ text: 'Gra' }, { text: 'ce' }] },
        { formula: 'LOWER("X@Y.COM")', result: 'x@y.com' },
        '2026-01-01',
      ],
    ]);
    const plan = await service.run('t1', 'immigration', 'leads_xlsx', {
      format: 'xlsx',
      content,
    });
    expect(plan.rows[0].values).toMatchObject({ firstName: 'Grace', email: 'x@y.com' });
  });

  it('rejects bytes that are not a workbook, with a 400', async () => {
    await expect(
      service.run('t1', 'immigration', 'leads_xlsx', {
        format: 'xlsx',
        content: Buffer.from('First Name,Email\nAda,a@b.com'),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('still accepts CSV text for an xlsx mapping — the field map is about columns, not bytes', async () => {
    const plan = await service.run(
      't1',
      'immigration',
      'leads_xlsx',
      'First Name,Email,Visa Expiry\nAda,a@b.com,2026-01-01',
    );
    expect(plan.totalRows).toBe(1);
    expect(plan.rows[0].action).toBe('create');
  });
});
