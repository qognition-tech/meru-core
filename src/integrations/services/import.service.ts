import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  EntityType,
  UniversalEntity,
} from '../../crm/entities/universal-entity.entity';
import { VerticalPackService } from '../../tenant/services/vertical-pack.service';

/** One `importMappings[]` entry, as the pack declares it. */
export interface ImportMappingDefinition {
  key: string;
  label: string;
  source: 'csv' | 'xlsx' | 'hubspot' | 'zoho' | 'salesforce';
  targetEntityType: string;
  fields: Array<{
    from: string;
    to: string;
    required?: boolean;
    transform?:
      | 'trim'
      | 'lowercase'
      | 'uppercase'
      | 'date_iso'
      | 'phone_e164'
      | 'country_iso2';
  }>;
  dedupeOn?: string[];
}

export type RowAction = 'create' | 'update' | 'skip';

export interface RowPlan {
  /** 1-based row number in the source file, so an error names what a human sees. */
  row: number;
  action: RowAction;
  /** The existing record this row matched, when it matched one. */
  matchedId?: string;
  values: Record<string, unknown>;
  errors: string[];
}

export interface ImportPlan {
  mappingKey: string;
  targetEntityType: string;
  totalRows: number;
  creates: number;
  updates: number;
  skipped: number;
  /** True when nothing was written — the default. */
  dryRun: boolean;
  /** Columns in the file that the mapping does not mention. */
  unmappedColumns: string[];
  /** Mapped columns that the file does not contain. */
  missingColumns: string[];
  rows: RowPlan[];
  committed?: { created: number; updated: number; failed: number };
}

/**
 * Bring records in from a spreadsheet, driven by the pack's `importMappings[]`.
 *
 * The ninth and last Layer 4 array. Field names belong to the vertical, not to
 * core — core has no idea what `visaSubclass` is — so the map lives in the pack
 * and this service is the generic engine that applies it.
 *
 * **Dry run is the default and the point.** An import is the single easiest way
 * for a firm to destroy its own data, and the failure is discovered days later
 * when someone notices two of every client. So the pipeline is
 * parse → map → *diff* → commit, and the diff is a first-class result a human
 * reads before anything is written: how many creates, how many updates, which
 * rows are broken and why, which columns nobody mapped.
 */
@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  /** Rows one import may carry. Beyond this, split the file. */
  private static readonly MAX_ROWS = 5_000;

  constructor(
    @InjectRepository(UniversalEntity)
    private readonly entities: Repository<UniversalEntity>,
    private readonly packs: VerticalPackService,
  ) {}

  /** Every mapping the caller's vertical declares, for a UI that offers a choice. */
  async listMappings(vertical: string | null): Promise<ImportMappingDefinition[]> {
    return this.packs.list<ImportMappingDefinition>(vertical, 'importMappings');
  }

  /**
   * Plan an import, and optionally commit it.
   *
   * `commit: false` (the default) writes nothing and returns the same plan the
   * commit would act on — so what a reviewer approves is exactly what runs.
   */
  async run(
    tenantId: string,
    vertical: string | null,
    mappingKey: string,
    csv: string,
    options: { commit?: boolean } = {},
  ): Promise<ImportPlan> {
    const mappings = await this.listMappings(vertical);
    const mapping = mappings.find((m) => m.key === mappingKey);

    if (!mapping) {
      throw new BadRequestException(
        mappings.length
          ? `No import mapping '${mappingKey}'. This vertical declares: ${mappings
              .map((m) => m.key)
              .join(', ')}`
          : `No import mapping '${mappingKey}' — this vertical's config pack declares none`,
      );
    }

    const table = ImportService.parseCsv(csv);
    if (table.length === 0) {
      throw new BadRequestException('The file has no header row');
    }

    const header = table[0].map((h) => h.trim());
    const dataRows = table.slice(1).filter((r) => r.some((c) => c.trim()));

    if (dataRows.length > ImportService.MAX_ROWS) {
      throw new BadRequestException(
        `${dataRows.length} rows exceeds the ${ImportService.MAX_ROWS}-row limit for one import`,
      );
    }

    const mappedColumns = new Set(mapping.fields.map((f) => f.from));
    const plan: ImportPlan = {
      mappingKey: mapping.key,
      targetEntityType: mapping.targetEntityType,
      totalRows: dataRows.length,
      creates: 0,
      updates: 0,
      skipped: 0,
      dryRun: !options.commit,
      // Surfaced rather than ignored: an unmapped column is usually a column
      // somebody expected to be imported, and finding out afterwards means
      // re-importing.
      unmappedColumns: header.filter((h) => h && !mappedColumns.has(h)),
      missingColumns: [...mappedColumns].filter((c) => !header.includes(c)),
      rows: [],
    };

    for (const [index, cells] of dataRows.entries()) {
      const rowPlan = await this.planRow(
        tenantId,
        mapping,
        header,
        cells,
        index + 2, // +1 for zero-index, +1 for the header line
      );
      plan.rows.push(rowPlan);
      if (rowPlan.action === 'create') plan.creates++;
      else if (rowPlan.action === 'update') plan.updates++;
      else plan.skipped++;
    }

    if (!options.commit) return plan;

    plan.committed = await this.commit(tenantId, mapping, plan);
    return plan;
  }

  private async planRow(
    tenantId: string,
    mapping: ImportMappingDefinition,
    header: string[],
    cells: string[],
    rowNumber: number,
  ): Promise<RowPlan> {
    const values: Record<string, unknown> = {};
    const errors: string[] = [];

    for (const field of mapping.fields) {
      const columnIndex = header.indexOf(field.from);
      const raw = columnIndex >= 0 ? (cells[columnIndex] ?? '') : '';
      const value = ImportService.applyTransform(raw.trim(), field.transform);

      if (field.required && (value === '' || value === null)) {
        errors.push(`'${field.from}' is required and empty`);
        continue;
      }
      if (value === '' || value === null) continue;

      values[field.to] = value;
    }

    if (errors.length > 0) {
      return { row: rowNumber, action: 'skip', values, errors };
    }

    const match = await this.findExisting(tenantId, mapping, values);

    return {
      row: rowNumber,
      action: match ? 'update' : 'create',
      matchedId: match?.id,
      values,
      errors,
    };
  }

  /**
   * Find the record this row updates, by the mapping's `dedupeOn` fields.
   *
   * A mapping with no `dedupeOn` creates every time — stated in the plan as a
   * row of creates rather than hidden, because a re-run after a partial failure
   * then produces two copies of everything, and the reviewer should see that
   * before approving rather than after.
   */
  private async findExisting(
    tenantId: string,
    mapping: ImportMappingDefinition,
    values: Record<string, unknown>,
  ): Promise<UniversalEntity | null> {
    const keys = (mapping.dedupeOn ?? []).filter((k) => values[k] != null);
    if (keys.length === 0) return null;

    const qb = this.entities
      .createQueryBuilder('e')
      .where('e."tenantId" = :tenantId', { tenantId })
      .andWhere('e.type = :type', { type: mapping.targetEntityType })
      .andWhere('e."deletedAt" IS NULL');

    for (const [i, key] of keys.entries()) {
      const value = String(values[key]);
      if (ImportService.TOP_LEVEL_FIELDS.has(key)) {
        qb.andWhere(`e."${key}" = :v${i}`, { [`v${i}`]: value });
      } else {
        const attribute = key.replace(/^verticalAttributes\./, '');
        qb.andWhere(`e."verticalAttributes"->>:k${i} = :v${i}`, {
          [`k${i}`]: attribute,
          [`v${i}`]: value,
        });
      }
    }

    return qb.getOne();
  }

  private async commit(
    tenantId: string,
    mapping: ImportMappingDefinition,
    plan: ImportPlan,
  ): Promise<{ created: number; updated: number; failed: number }> {
    let created = 0;
    let updated = 0;
    let failed = 0;

    for (const row of plan.rows) {
      if (row.action === 'skip') continue;

      try {
        const { columns, attributes } = ImportService.split(row.values);

        if (row.action === 'update' && row.matchedId) {
          const existing = await this.entities.findOne({
            where: { id: row.matchedId, tenantId },
          });
          if (!existing) {
            failed++;
            continue;
          }
          await this.entities.update(
            { id: row.matchedId, tenantId },
            {
              ...columns,
              // Merge, never replace: an import that carries three columns must
              // not erase the twenty fields it says nothing about.
              verticalAttributes: {
                ...(existing.verticalAttributes ?? {}),
                ...attributes,
              },
            },
          );
          updated++;
        } else {
          await this.entities.save(
            this.entities.create({
              tenantId,
              type: mapping.targetEntityType as EntityType,
              ...columns,
              verticalAttributes: attributes,
            }),
          );
          created++;
        }
      } catch (err) {
        row.errors.push(
          err instanceof Error ? err.message : String(err),
        );
        failed++;
      }
    }

    this.logger.log(
      `Import '${mapping.key}' committed for tenant ${tenantId}: ` +
        `${created} created, ${updated} updated, ${failed} failed`,
    );
    return { created, updated, failed };
  }

  /** Entity columns a mapping may target directly; everything else is jsonb. */
  private static readonly TOP_LEVEL_FIELDS = new Set([
    'firstName',
    'lastName',
    'email',
    'phoneNumber',
    'status',
    'dueDate',
    'assignedTo',
  ]);

  private static split(values: Record<string, unknown>): {
    columns: Record<string, unknown>;
    attributes: Record<string, unknown>;
  } {
    const columns: Record<string, unknown> = {};
    const attributes: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(values)) {
      if (ImportService.TOP_LEVEL_FIELDS.has(key)) columns[key] = value;
      else attributes[key.replace(/^verticalAttributes\./, '')] = value;
    }

    return { columns, attributes };
  }

  private static applyTransform(
    value: string,
    transform?: ImportMappingDefinition['fields'][number]['transform'],
  ): string {
    if (!transform) return value;

    switch (transform) {
      case 'trim':
        return value.trim();
      case 'lowercase':
        return value.toLowerCase();
      case 'uppercase':
        return value.toUpperCase();
      case 'country_iso2':
        return value.trim().toUpperCase().slice(0, 2);
      case 'phone_e164': {
        const digits = value.replace(/[^\d+]/g, '');
        return digits.startsWith('+') ? digits : `+${digits}`;
      }
      case 'date_iso': {
        // Day-first before month-first: a firm exporting from a UK or AU system
        // writes 03/06/2026 meaning 3 June, and `new Date()` reads it as
        // 6 March — a nine-week error in a visa expiry, silently.
        const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value.trim());
        if (dmy) {
          const [, d, m, y] = dmy;
          return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        }
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime())
          ? value
          : parsed.toISOString().slice(0, 10);
      }
      default:
        return value;
    }
  }

  /**
   * RFC-4180 CSV, including quoted fields containing commas and newlines.
   *
   * Written out rather than split on `\n` because an address field with a line
   * break inside quotes silently shifts every subsequent row by one, and the
   * result is an import that looks like it worked.
   */
  static parseCsv(input: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let inQuotes = false;

    const text = input.replace(/^﻿/, '').replace(/\r\n/g, '\n');

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (inQuotes) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i++;
          } else inQuotes = false;
        } else cell += char;
        continue;
      }

      if (char === '"') inQuotes = true;
      else if (char === ',') {
        row.push(cell);
        cell = '';
      } else if (char === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += char;
    }

    if (cell !== '' || row.length > 0) {
      row.push(cell);
      rows.push(row);
    }

    return rows;
  }
}
