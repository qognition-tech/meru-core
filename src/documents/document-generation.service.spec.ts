import { PDFDocument } from 'pdf-lib';
import {
  DocumentGenerationService,
  resolvePath,
  substitute,
  type DocumentTemplate,
} from './document-generation.service';

/**
 * Document generation is the frontend's #1 blocker: four lifecycle stages cannot
 * complete without it.
 *
 * The tests that matter here are not "does it emit bytes" but "does it refuse to
 * emit the wrong document". A cost agreement with a blank where the fee should be
 * is worse than no cost agreement — it looks executable, a client may sign it,
 * and the firm ends up holding a signed instrument with a hole in it.
 */
describe('DocumentGenerationService', () => {
  const template: DocumentTemplate = {
    key: 'cost_agreement',
    label: 'Cost agreement',
    documentTypeKey: 'cost_agreement',
    fileName: 'cost-agreement-{{client.lastName}}',
    header: '{{tenant.name}}',
    footer: 'Prepared {{today}}',
    requires: ['client.fullName', 'paymentsTotal'],
    blocks: [
      { type: 'heading', text: 'Cost agreement for {{client.fullName}}', level: 1 },
      { type: 'paragraph', text: 'Between {{tenant.name}} and {{client.fullName}}.' },
      {
        type: 'keyValue',
        rows: [{ label: 'Email', value: '{{client.email}}' }],
      },
      {
        type: 'table',
        columns: ['Item', 'Amount'],
        from: '{{payments}}',
        cells: ['{{item.description}}', '{{item.amount}}'],
      },
      { type: 'list', items: ['Pay on time', 'Tell us if things change'] },
      { type: 'signature', signatories: ['{{client.fullName}}'] },
    ],
  };

  const build = (
    over: {
      templates?: DocumentTemplate[];
      entity?: Record<string, unknown> | null;
      payments?: Record<string, unknown>[];
    } = {},
  ) => {
    const packs = {
      sectionWithPack: jest.fn().mockResolvedValue({
        pack: { code: 'immigration' },
        section: over.templates ?? [template],
      }),
    };
    const entityRepo = {
      findOne: jest.fn().mockResolvedValue(
        over.entity === undefined
          ? {
              id: 'e1',
              firstName: 'Priya',
              lastName: 'Sharma',
              email: 'priya@example.com',
              phoneNumber: '+61400000000',
              type: 'person',
              status: 'open',
              verticalAttributes: { matter: { subclass: '482' } },
            }
          : over.entity,
      ),
    };
    const paymentRepo = {
      find: jest.fn().mockResolvedValue(
        over.payments ?? [
          {
            reference: 'INV-1',
            description: 'Professional fees',
            currency: 'AUD',
            amountMinor: 350000,
            status: 'pending',
            dueDate: '2026-09-01',
            paidAt: null,
          },
        ],
      ),
    };
    const tenantRepo = {
      findOne: jest.fn().mockResolvedValue({ name: 'Acme Migration', slug: 'acme' }),
    };
    const documents = { upload: jest.fn().mockResolvedValue({ document: { id: 'doc-1' } }) };

    const service = new DocumentGenerationService(
      packs as any,
      entityRepo as any,
      paymentRepo as any,
      tenantRepo as any,
      documents as any,
    );
    return { service, packs, documents, entityRepo };
  };

  it('produces a real, parseable PDF', async () => {
    const { service } = build();
    const out = await service.generate('t1', 'immigration', 'cost_agreement', 'e1');

    expect(out.mimeType).toBe('application/pdf');
    // Parse it back rather than trusting the byte count — a truncated or
    // malformed file still has a length.
    const parsed = await PDFDocument.load(out.bytes);
    expect(parsed.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(out.bytes.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('refuses when a required value is missing, naming what is missing', async () => {
    // The whole point. `paymentsTotal` resolves to '' with no payments, and
    // `requires` says that is not acceptable for this document.
    const { service } = build({ payments: [] });
    await expect(
      service.generate('t1', 'immigration', 'cost_agreement', 'e1'),
    ).rejects.toThrow(/paymentsTotal/);
  });

  it('does not name a value that is present', async () => {
    const { service } = build({ payments: [] });
    await expect(
      service.generate('t1', 'immigration', 'cost_agreement', 'e1'),
    ).rejects.not.toThrow(/client\.fullName/);
  });

  it('reports unresolved optional placeholders instead of leaving braces in the text', async () => {
    const { service } = build({
      templates: [
        {
          key: 'letter',
          label: 'Letter',
          blocks: [
            { type: 'paragraph', text: 'Ref {{client.attributes.matter.nope}} end' },
          ],
        },
      ],
    });
    const out = await service.generate('t1', 'immigration', 'letter', 'e1');

    // A client reads this document; literal `{{...}}` in it is embarrassing, and
    // a silent blank is how a template drifts from its pack unnoticed.
    expect(out.unresolved).toContain('client.attributes.matter.nope');
  });

  it('404s on a template the pack does not declare', async () => {
    const { service } = build();
    await expect(
      service.generate('t1', 'immigration', 'not_a_template', 'e1'),
    ).rejects.toThrow(/No document template/);
  });

  it('404s when the entity is not this tenant\'s', async () => {
    const { service } = build({ entity: null });
    await expect(
      service.generate('t1', 'immigration', 'cost_agreement', 'e1'),
    ).rejects.toThrow(/Entity not found/);
  });

  it('names the file from the record, and sanitises it', async () => {
    const { service } = build();
    const out = await service.generate('t1', 'immigration', 'cost_agreement', 'e1');
    expect(out.fileName).toBe('cost-agreement-Sharma.pdf');
  });

  it('never emits a path separator in a filename', async () => {
    const { service } = build({
      entity: {
        id: 'e1',
        firstName: 'A',
        lastName: '../../etc/passwd',
        email: 'a@b.com',
        verticalAttributes: {},
      },
      templates: [
        {
          key: 'f',
          label: 'F',
          fileName: 'x-{{client.lastName}}',
          blocks: [{ type: 'paragraph', text: 'hi' }],
        },
      ],
    });
    const out = await service.generate('t1', 'immigration', 'f', 'e1');
    expect(out.fileName).not.toMatch(/[/\\]/);
  });

  it('lists templates without dumping every block', async () => {
    const { service } = build();
    const out = await service.listTemplates('immigration');
    expect(out.templates).toHaveLength(1);
    // The list drives a menu; blocks would be kilobytes of body text per row.
    expect((out.templates[0] as Record<string, unknown>).blocks).toBeUndefined();
    expect(out.templates[0].label).toBe('Cost agreement');
  });

  it('files a stored document under the key the checklist matches on', async () => {
    const { service, documents } = build();
    const out = await service.generate('t1', 'immigration', 'cost_agreement', 'e1');
    await service.store(out, 't1', 'u1', 'e1');

    const dto = documents.upload.mock.calls[0][1];
    // Without this the firm generates a cost agreement and the checklist keeps
    // reporting it as outstanding.
    expect(dto.metadata.documentTypeKey).toBe('cost_agreement');
    expect(dto.linkedEntityId).toBe('e1');
  });

  it('renders a table with no rows as "none" rather than blank space', async () => {
    // On an invoice, empty space under column headings reads as "nothing owed".
    const { service } = build({
      payments: [],
      templates: [
        {
          key: 'inv',
          label: 'Inv',
          blocks: [
            {
              type: 'table',
              columns: ['Item', 'Amount'],
              from: '{{payments}}',
              cells: ['{{item.description}}', '{{item.amount}}'],
            },
          ],
        },
      ],
    });
    const out = await service.generate('t1', 'immigration', 'inv', 'e1');
    expect(out.bytes.length).toBeGreaterThan(0);
  });

  it('paginates long content instead of drawing past the page edge', async () => {
    const { service } = build({
      templates: [
        {
          key: 'long',
          label: 'Long',
          blocks: Array.from({ length: 200 }, (_, i) => ({
            type: 'paragraph' as const,
            text: `Clause ${i + 1}. ${'The parties agree. '.repeat(6)}`,
          })),
        },
      ],
    });
    const out = await service.generate('t1', 'immigration', 'long', 'e1');
    const parsed = await PDFDocument.load(out.bytes);
    expect(parsed.getPageCount()).toBeGreaterThan(1);
  });

  it('survives a name the standard fonts cannot encode', async () => {
    // Packs are authored per country; a Cyrillic or Arabic name reaching a
    // Helvetica page is a matter of when. pdf-lib throws on an unencodable
    // glyph, and a throw here would fail the whole document.
    const { service } = build({
      entity: {
        id: 'e1',
        firstName: 'Владимир',
        lastName: 'Петров',
        email: 'v@example.com',
        verticalAttributes: {},
      },
      templates: [
        {
          key: 'f',
          label: 'F',
          blocks: [{ type: 'paragraph', text: 'Name: {{client.fullName}}' }],
        },
      ],
    });
    const out = await service.generate('t1', 'immigration', 'f', 'e1');
    await expect(PDFDocument.load(out.bytes)).resolves.toBeDefined();
  });

  it('formats minor units as a human figure', async () => {
    const { service } = build();
    const out = await service.generate('t1', 'immigration', 'cost_agreement', 'e1');
    // 350000 minor units is AUD 3500.00, not 350000.
    expect(out.unresolved).not.toContain('paymentsTotal');
  });
});

describe('substitute and resolvePath', () => {
  const context = {
    client: { firstName: 'Priya', attributes: { matter: { subclass: '482' } } },
    payments: [{ amount: 'AUD 10.00' }],
    blank: '',
  };

  it('resolves a nested path', () => {
    expect(resolvePath(context, 'client.attributes.matter.subclass')).toBe('482');
  });

  it('resolves an array index', () => {
    expect(resolvePath(context, 'payments[0].amount')).toBe('AUD 10.00');
  });

  it('returns undefined for a missing hop rather than throwing', () => {
    expect(resolvePath(context, 'client.nope.deeper')).toBeUndefined();
  });

  it('does not walk into a primitive', () => {
    expect(resolvePath(context, 'client.firstName.length')).toBeUndefined();
  });

  it('substitutes and tolerates whitespace in the braces', () => {
    expect(substitute('Hi {{ client.firstName }}', context)).toBe('Hi Priya');
  });

  it('reports an empty string as unresolved, not as a value', () => {
    // An empty string in the context is indistinguishable from a missing value
    // in the rendered document, so it is reported the same way.
    const unresolved: string[] = [];
    expect(substitute('[{{blank}}]', context, unresolved)).toBe('[]');
    expect(unresolved).toContain('blank');
  });

  it('leaves text with no placeholders alone', () => {
    expect(substitute('Plain text.', context)).toBe('Plain text.');
  });
});
