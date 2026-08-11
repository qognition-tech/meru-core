import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';
import { UniversalEntity } from '../crm/entities/universal-entity.entity';
import { Payment } from '../billing/entities/payment.entity';
import { Tenant } from '../iam/entities/tenant.entity';
import { DocumentsService } from './documents.service';

/** One block of a pack-authored document. Mirrors DocumentBlockSchema. */
export interface DocumentBlock {
  type:
    | 'heading'
    | 'paragraph'
    | 'spacer'
    | 'keyValue'
    | 'table'
    | 'list'
    | 'signature'
    | 'pageBreak';
  text?: string;
  level?: number;
  rows?: Array<{ label: string; value: string }>;
  columns?: string[];
  from?: string;
  cells?: string[];
  items?: string[];
  /** `table` relative column widths. Absent means equal columns. */
  widths?: number[];
  signatories?: string[];
  fontSize?: number;
  bold?: boolean;
}

/** A pack-authored document template. Mirrors DocumentTemplateSchema. */
export interface DocumentTemplate {
  key: string;
  label: string;
  documentTypeKey?: string;
  fileName?: string;
  pageSize?: 'A4' | 'LETTER';
  header?: string;
  footer?: string;
  requires?: string[];
  blocks: DocumentBlock[];
}

export interface GeneratedDocument {
  templateKey: string;
  label: string;
  /** Set when the template satisfies a `documentTypes` requirement. */
  documentTypeKey?: string;
  fileName: string;
  mimeType: 'application/pdf';
  bytes: Buffer;
  /** Paths that resolved to nothing. Empty when every placeholder was filled. */
  unresolved: string[];
}

const PAGE_SIZES = {
  A4: { width: 595.28, height: 841.89 },
  LETTER: { width: 612, height: 792 },
} as const;

const MARGIN = 56;
const HEADING_SIZES = [20, 15, 12.5] as const;
const BODY_SIZE = 10.5;
const LINE_GAP = 1.45;

/**
 * Renders the documents a firm has to hand a client: cost agreements, invoices,
 * final drafts, grant letters.
 *
 * The frontend ranks this its single biggest blocker — four lifecycle stages
 * cannot complete without it, and it was the one gap where the workaround
 * ("record an acceptance note") is visibly not the thing being asked for.
 *
 * Every word of every document comes from the config pack's
 * `documentTemplates[]`. This service knows how to lay out a heading, wrap a
 * paragraph, draw a table and rule a signature line; it does not know what a
 * cost agreement is, which is what keeps a second vertical from needing a second
 * generator (CLAUDE.md §5.5).
 *
 * pdf-lib rather than a headless browser: HTML pagination needs Chromium, which
 * will not start inside a 60-second serverless function with a read-only
 * filesystem. It is also CommonJS, which `check:cjs` requires.
 */
@Injectable()
export class DocumentGenerationService {
  private readonly logger = new Logger(DocumentGenerationService.name);

  constructor(
    private readonly packs: VerticalPackService,
    @InjectRepository(UniversalEntity)
    private readonly entityRepo: Repository<UniversalEntity>,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    private readonly documents: DocumentsService,
  ) {}

  /** Every template the tenant's pack declares. */
  async listTemplates(
    vertical: string | null,
  ): Promise<{ packCode: string | null; templates: Array<Omit<DocumentTemplate, 'blocks'>> }> {
    const { pack, section } = await this.packs.sectionWithPack<DocumentTemplate[]>(
      vertical,
      'documentTemplates',
    );

    return {
      packCode: pack?.code ?? null,
      templates: (section ?? []).map(({ blocks: _blocks, ...rest }) => rest),
    };
  }

  /**
   * Render one template for one record.
   *
   * Refuses rather than producing a document with a blank where a number should
   * be. A cost agreement missing its fee, or an invoice missing its amount, is
   * worse than no document: it looks executable, a client may sign it, and the
   * firm has a signed instrument with a hole in it. `requires` is the pack
   * author's declaration of which holes are unacceptable.
   */
  async generate(
    tenantId: string,
    vertical: string | null,
    templateKey: string,
    entityId?: string,
  ): Promise<GeneratedDocument> {
    const { section } = await this.packs.sectionWithPack<DocumentTemplate[]>(
      vertical,
      'documentTemplates',
    );
    const template = (section ?? []).find((t) => t.key === templateKey);

    if (!template) {
      throw new NotFoundException(
        `No document template '${templateKey}' in this tenant's pack. ` +
          `GET /documents/templates lists what is available.`,
      );
    }

    const context = await this.buildContext(tenantId, entityId);

    // Empty counts as missing, not just absent. `substitute` already reports an
    // empty string as unresolved, and in a rendered document a blank and a
    // missing key are the same thing to whoever reads it.
    const missing = (template.requires ?? []).filter((path) => {
      const value = resolvePath(context, path);
      return value === undefined || value === null || value === '';
    });
    if (missing.length) {
      throw new BadRequestException(
        `Cannot generate '${template.label}': ${missing.join(', ')} ` +
          `${missing.length === 1 ? 'is' : 'are'} not available on this record. ` +
          'The template declares these as required, so a document is not produced ' +
          'with the values left blank.',
      );
    }

    const unresolved: string[] = [];
    const bytes = await this.render(template, context, unresolved);

    const stem = template.fileName
      ? substitute(template.fileName, context, unresolved)
      : `${template.key}`;

    this.logger.log(
      `Generated '${template.key}' for tenant ${tenantId}` +
        (entityId ? ` entity ${entityId}` : '') +
        (unresolved.length ? ` (${unresolved.length} unresolved placeholder(s))` : ''),
    );

    return {
      templateKey: template.key,
      label: template.label,
      documentTypeKey: template.documentTypeKey,
      fileName: `${sanitiseFileName(stem)}.pdf`,
      mimeType: 'application/pdf',
      bytes,
      unresolved: Array.from(new Set(unresolved)),
    };
  }

  /**
   * File a generated document against the record it is about.
   *
   * Routed through `DocumentsService.upload` rather than writing a row here, so
   * a generated document gets the same encryption, versioning, S3 key layout and
   * audit trail as an uploaded one. A second write path would be a second set of
   * those decisions to keep in step.
   *
   * `metadata.documentTypeKey` is set from the template, because that is what
   * `GET /documents/checklist` matches on — without it a generated cost
   * agreement would satisfy no requirement and the checklist would keep asking
   * for the document the firm had just produced.
   */
  async store(
    generated: GeneratedDocument,
    tenantId: string,
    userId: string,
    entityId?: string,
  ): Promise<{ documentId: string }> {
    const template = generated.templateKey;

    const file = {
      buffer: generated.bytes,
      size: generated.bytes.length,
      originalname: generated.fileName,
      mimetype: generated.mimeType,
      fieldname: 'file',
      encoding: '7bit',
    } as Express.Multer.File;

    const result = await this.documents.upload(
      file,
      {
        name: generated.label,
        originalFileName: generated.fileName,
        ...(entityId
          ? { linkedEntityType: 'entity', linkedEntityId: entityId }
          : {}),
        tags: ['generated', template],
        metadata: {
          generated: true,
          documentTemplateKey: template,
          ...(generated.documentTypeKey
            ? { documentTypeKey: generated.documentTypeKey }
            : {}),
          unresolvedPlaceholders: generated.unresolved,
        },
      } as never,
      tenantId,
      userId,
    );

    return { documentId: (result as { document?: { id: string } }).document?.id ?? '' };
  }

  /**
   * The values a template may reference.
   *
   * Generic on purpose: `tenant`, `client`, `payments`, `today`. A pack reaches
   * vertical data through `client.attributes`, which is the record's
   * `verticalAttributes` — so a visa subclass is addressable without core
   * knowing the word "subclass".
   */
  private async buildContext(
    tenantId: string,
    entityId?: string,
  ): Promise<Record<string, unknown>> {
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });

    const entity = entityId
      ? await this.entityRepo.findOne({ where: { id: entityId, tenantId } })
      : null;

    if (entityId && !entity) {
      throw new NotFoundException('Entity not found');
    }

    const payments = entityId
      ? await this.paymentRepo.find({
          where: [
            { tenantId, entityId },
            { tenantId, clientId: entityId },
          ],
          order: { createdAt: 'ASC' },
        })
      : [];

    const now = new Date();

    return {
      today: now.toISOString().slice(0, 10),
      now: now.toISOString(),
      tenant: {
        name: tenant?.name ?? '',
        slug: tenant?.slug ?? '',
      },
      client: entity
        ? {
            id: entity.id,
            firstName: entity.firstName ?? '',
            lastName: entity.lastName ?? '',
            fullName: [entity.firstName, entity.lastName].filter(Boolean).join(' '),
            email: entity.email ?? '',
            phoneNumber: entity.phoneNumber ?? '',
            type: entity.type,
            status: entity.status ?? '',
            attributes: entity.verticalAttributes ?? {},
          }
        : {},
      payments: payments.map((p) => ({
        reference: p.reference ?? '',
        description: p.description ?? '',
        currency: p.currency,
        // Minor units are the storage truth; a template wants the human figure.
        amount: formatMinor(p.amountMinor, p.currency),
        amountMinor: p.amountMinor,
        status: p.status,
        dueDate: p.dueDate ? String(p.dueDate).slice(0, 10) : '',
        paidAt: p.paidAt ? String(p.paidAt).slice(0, 10) : '',
      })),
      // Empty, not "0.00". No payment rows means nobody has said what is owed;
      // a zero is a figure, and printing one on a cost agreement asserts the
      // engagement is free (CLAUDE.md §5.2 — an empty population is not zero).
      // A template that must not go out without a total declares it in
      // `requires`, and this is what makes that check fire.
      paymentsTotal: payments.length
        ? formatMinor(
            payments.reduce((sum, p) => sum + Number(p.amountMinor ?? 0), 0),
            payments[0]?.currency ?? '',
          )
        : '',
    };
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  private async render(
    template: DocumentTemplate,
    context: Record<string, unknown>,
    unresolved: string[],
  ): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    const regular = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const size = PAGE_SIZES[template.pageSize ?? 'A4'];

    const state = {
      page: pdf.addPage([size.width, size.height]),
      y: size.height - MARGIN,
    };

    const contentWidth = size.width - MARGIN * 2;

    const newPage = () => {
      state.page = pdf.addPage([size.width, size.height]);
      state.y = size.height - MARGIN;
      if (template.header) {
        drawHeader(state, template.header, context, regular, unresolved, size.width);
      }
    };

    /** Reserve vertical space, starting a page when the block will not fit. */
    const need = (height: number) => {
      if (state.y - height < MARGIN + 24) newPage();
    };

    if (template.header) {
      drawHeader(state, template.header, context, regular, unresolved, size.width);
    }

    for (const block of template.blocks) {
      switch (block.type) {
        case 'pageBreak':
          newPage();
          break;

        case 'spacer':
          state.y -= block.fontSize ?? 12;
          break;

        case 'heading': {
          const fontSize =
            block.fontSize ?? HEADING_SIZES[Math.min((block.level ?? 1) - 1, 2)];
          const lines = wrap(
            substitute(block.text ?? '', context, unresolved),
            bold,
            fontSize,
            contentWidth,
          );
          need(fontSize * LINE_GAP * lines.length + 8);
          for (const line of lines) {
            state.page.drawText(line, {
              x: MARGIN,
              y: state.y - fontSize,
              size: fontSize,
              font: bold,
            });
            state.y -= fontSize * LINE_GAP;
          }
          state.y -= 6;
          break;
        }

        case 'paragraph': {
          const fontSize = block.fontSize ?? BODY_SIZE;
          const font = block.bold ? bold : regular;
          const lines = wrap(
            substitute(block.text ?? '', context, unresolved),
            font,
            fontSize,
            contentWidth,
          );
          for (const line of lines) {
            need(fontSize * LINE_GAP);
            state.page.drawText(line, {
              x: MARGIN,
              y: state.y - fontSize,
              size: fontSize,
              font,
            });
            state.y -= fontSize * LINE_GAP;
          }
          state.y -= 6;
          break;
        }

        case 'list': {
          const fontSize = block.fontSize ?? BODY_SIZE;
          for (const raw of block.items ?? []) {
            const lines = wrap(
              substitute(raw, context, unresolved),
              regular,
              fontSize,
              contentWidth - 16,
            );
            lines.forEach((line, i) => {
              need(fontSize * LINE_GAP);
              state.page.drawText(i === 0 ? `•  ${line}` : `    ${line}`, {
                x: MARGIN,
                y: state.y - fontSize,
                size: fontSize,
                font: regular,
              });
              state.y -= fontSize * LINE_GAP;
            });
          }
          state.y -= 6;
          break;
        }

        case 'keyValue': {
          const fontSize = block.fontSize ?? BODY_SIZE;
          const labelWidth = contentWidth * 0.38;
          for (const row of block.rows ?? []) {
            const value = substitute(row.value, context, unresolved);
            const valueLines = wrap(
              value,
              regular,
              fontSize,
              contentWidth - labelWidth,
            );
            need(fontSize * LINE_GAP * Math.max(1, valueLines.length));
            state.page.drawText(sanitiseText(substitute(row.label, context, unresolved)), {
              x: MARGIN,
              y: state.y - fontSize,
              size: fontSize,
              font: bold,
            });
            valueLines.forEach((line, i) => {
              if (i > 0) need(fontSize * LINE_GAP);
              state.page.drawText(line, {
                x: MARGIN + labelWidth,
                y: state.y - fontSize,
                size: fontSize,
                font: regular,
              });
              state.y -= fontSize * LINE_GAP;
            });
          }
          state.y -= 6;
          break;
        }

        case 'table': {
          const fontSize = block.fontSize ?? BODY_SIZE - 0.5;
          const columns = block.columns ?? [];
          const source = block.from
            ? resolvePath(context, stripBraces(block.from))
            : [];
          const items = Array.isArray(source) ? source : [];
          // Equal columns squeeze a description to the width of a date, which
          // truncated "Professional fees - subclass 482" to "Professional fees
          // - subc...". `widths` are relative weights; absent, columns are equal.
          const weights =
            block.widths && block.widths.length === columns.length
              ? block.widths
              : columns.map(() => 1);
          const weightTotal = weights.reduce((a, b) => a + b, 0) || 1;
          const offsets: number[] = [];
          const colWidths: number[] = [];
          let cursor = 0;
          for (const weight of weights) {
            offsets.push(cursor);
            const w = (weight / weightTotal) * contentWidth;
            colWidths.push(w);
            cursor += w;
          }

          need(fontSize * LINE_GAP * 2);
          columns.forEach((heading, i) => {
            state.page.drawText(truncate(heading, bold, fontSize, colWidths[i] - 6), {
              x: MARGIN + offsets[i],
              y: state.y - fontSize,
              size: fontSize,
              font: bold,
            });
          });
          state.y -= fontSize * LINE_GAP;
          state.page.drawLine({
            start: { x: MARGIN, y: state.y + 3 },
            end: { x: MARGIN + contentWidth, y: state.y + 3 },
            thickness: 0.5,
            color: rgb(0.7, 0.7, 0.7),
          });
          state.y -= 4;

          if (items.length === 0) {
            // An empty table says so. A blank space under headings reads as a
            // rendering failure, and on an invoice it reads as "nothing owed".
            need(fontSize * LINE_GAP);
            state.page.drawText('— none —', {
              x: MARGIN,
              y: state.y - fontSize,
              size: fontSize,
              font: regular,
              color: rgb(0.45, 0.45, 0.45),
            });
            state.y -= fontSize * LINE_GAP;
          }

          for (const item of items) {
            need(fontSize * LINE_GAP);
            (block.cells ?? []).forEach((cell, i) => {
              const text = substitute(cell, { ...context, item }, unresolved);
              state.page.drawText(truncate(text, regular, fontSize, (colWidths[i] ?? contentWidth) - 6), {
                x: MARGIN + (offsets[i] ?? 0),
                y: state.y - fontSize,
                size: fontSize,
                font: regular,
              });
            });
            state.y -= fontSize * LINE_GAP;
          }
          state.y -= 8;
          break;
        }

        case 'signature': {
          const fontSize = block.fontSize ?? BODY_SIZE;
          for (const signatory of block.signatories ?? []) {
            need(56);
            state.y -= 24;
            state.page.drawLine({
              start: { x: MARGIN, y: state.y },
              end: { x: MARGIN + contentWidth * 0.46, y: state.y },
              thickness: 0.75,
              color: rgb(0.2, 0.2, 0.2),
            });
            state.page.drawLine({
              start: { x: MARGIN + contentWidth * 0.56, y: state.y },
              end: { x: MARGIN + contentWidth, y: state.y },
              thickness: 0.75,
              color: rgb(0.2, 0.2, 0.2),
            });
            state.y -= fontSize + 3;
            state.page.drawText(sanitiseText(substitute(signatory, context, unresolved)), {
              x: MARGIN,
              y: state.y,
              size: fontSize - 1,
              font: regular,
              color: rgb(0.35, 0.35, 0.35),
            });
            state.page.drawText('Date', {
              x: MARGIN + contentWidth * 0.56,
              y: state.y,
              size: fontSize - 1,
              font: regular,
              color: rgb(0.35, 0.35, 0.35),
            });
            state.y -= 12;
          }
          break;
        }
      }
    }

    // Footers last, so "Page n of m" can know m.
    const pages = pdf.getPages();
    pages.forEach((page, i) => {
      const label = `Page ${i + 1} of ${pages.length}`;
      const footerText = template.footer
        ? `${substitute(template.footer, context, unresolved)}   ·   ${label}`
        : label;
      page.drawText(truncate(footerText, regular, 8, size.width - MARGIN * 2), {
        x: MARGIN,
        y: MARGIN / 2,
        size: 8,
        font: regular,
        color: rgb(0.45, 0.45, 0.45),
      });
    });

    return Buffer.from(await pdf.save());
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function drawHeader(
  state: { page: PDFPage; y: number },
  header: string,
  context: Record<string, unknown>,
  font: PDFFont,
  unresolved: string[],
  pageWidth: number,
): void {
  const text = substitute(header, context, unresolved);
  state.page.drawText(truncate(text, font, 9, pageWidth - MARGIN * 2), {
    x: MARGIN,
    y: state.page.getHeight() - MARGIN / 2 - 9,
    size: 9,
    font,
    color: rgb(0.45, 0.45, 0.45),
  });
  state.y -= 10;
}

/**
 * Replace `{{path}}` with values from the context.
 *
 * An unresolved path becomes an empty string and is *reported* rather than left
 * as literal `{{client.email}}` in a document a client reads. The caller returns
 * the list, so a UI can warn before a half-filled agreement is sent — silently
 * blank is how a template drifts out of step with a pack and nobody notices.
 */
export function substitute(
  template: string,
  context: Record<string, unknown>,
  unresolved: string[] = [],
): string {
  return template.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_match, path: string) => {
    const value = resolvePath(context, path);
    if (value === undefined || value === null || value === '') {
      unresolved.push(path);
      return '';
    }
    return String(value);
  });
}

/** `a.b[0].c` against a plain object. Returns undefined for any missing hop. */
export function resolvePath(source: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);

  let current: unknown = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stripBraces(value: string): string {
  return value.replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '');
}

/** Greedy word wrap measured in the real font, so nothing overruns the margin. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!text) return [''];

  // Sanitised here because this is the funnel into `drawText` for every text
  // block. Doing it only in `widthOf` measured a safe string and then drew an
  // unsafe one, and pdf-lib throws on a glyph WinAnsi cannot encode — one
  // Cyrillic name in a client record would have failed the whole document.
  const out: string[] = [];
  for (const paragraph of sanitiseText(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (widthOf(candidate, font, size) <= maxWidth || !line) {
        line = candidate;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

function truncate(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (widthOf(text, font, size) <= maxWidth) return sanitiseText(text);
  let cut = text;
  while (cut.length > 1 && widthOf(`${cut}…`, font, size) > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return sanitiseText(`${cut}…`);
}

/**
 * Measure, falling back to an estimate for characters the font cannot encode.
 *
 * `widthOfTextAtSize` throws on a glyph missing from WinAnsi — and pack content
 * is authored per country, so a Cyrillic or Arabic name reaching a Helvetica
 * page is a matter of when, not if. A throw here would fail the whole document.
 */
function widthOf(text: string, font: PDFFont, size: number): number {
  try {
    return font.widthOfTextAtSize(sanitiseText(text), size);
  } catch {
    return text.length * size * 0.5;
  }
}

/**
 * Typographic characters an author will actually type, mapped to what the
 * standard fonts can draw.
 *
 * pdf-lib's WinAnsi encoding rejects any code point above 0xFF, which includes
 * the em dash, the ellipsis and curly quotes — exactly the punctuation a
 * professionally written cost agreement is full of. Stripping them to `?`
 * produced "Professional fees ? subclass 482" in a document a client reads.
 */
const TRANSLITERATIONS: ReadonlyArray<[RegExp, string]> = [
  [/[\u2014\u2015]/g, '--'],
  [/[\u2013\u2212]/g, '-'],
  [/[\u2018\u2019\u201A\u201B]/g, "'"],
  [/[\u201C\u201D\u201E\u201F]/g, '"'],
  [/\u2026/g, '...'],
  [/\u2022/g, '-'],
  [/\u00A0/g, ' '],
  [/[\u2039\u203A]/g, "'"],
  [/[\u00AB\u00BB]/g, '"'],
  [/\u2044/g, '/'],
  [/\u20AC/g, 'EUR'],
];

/**
 * Make text drawable by a standard font.
 *
 * Common punctuation is transliterated rather than destroyed; anything still
 * unencodable becomes `?`, which is visibly wrong and therefore gets reported,
 * rather than a silent gap where a name should be. A script the standard fonts
 * cannot represent at all — Cyrillic, Arabic, CJK — needs an embedded Unicode
 * font, which means shipping a font file in `vercel.json` → `includeFiles`.
 */
function sanitiseText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TRANSLITERATIONS) {
    out = out.replace(pattern, replacement);
  }
  // eslint-disable-next-line no-control-regex
  return out.replace(/[^\x00-\xFF]/g, '?');
}

function sanitiseFileName(stem: string): string {
  const cleaned = stem
    .replace(/[^\w\-. ]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || 'document';
}

/** Integer minor units to a display figure. 45000 → "450.00". */
function formatMinor(amountMinor: number | string, currency: string): string {
  const value = Number(amountMinor ?? 0) / 100;
  const formatted = value.toFixed(2);
  return currency ? `${currency} ${formatted}` : formatted;
}
