import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScreeningResult } from '../entities/screening-result.entity';
import { WatchlistEntry } from '../entities/watchlist-entry.entity';
import {
  ScreeningEngine,
  type ScreeningRequest,
  type ScreeningResult as EngineResult,
} from './screening.engine';
import { TenantContext } from '../../core/tenancy/tenant-context';

export interface RescreenSummary {
  candidates: number;
  rescreened: number;
  changed: Array<{
    tenantId: string;
    entityId: string | null;
    entityName: string;
    from: string;
    to: string;
  }>;
  skippedReason?: string;
}

/**
 * Re-runs screening for records whose result predates the current watchlist.
 *
 * The risk this addresses is specific: sanctions lists change daily, and a
 * name that screened clear last month can be designated today. A firm that
 * screened at onboarding and never again is reporting a clear result that
 * expired without anyone being told. Detecting that is not optional diligence,
 * it is the point of screening.
 */
@Injectable()
export class RescreeningService {
  private readonly logger = new Logger(RescreeningService.name);

  constructor(
    @InjectRepository(ScreeningResult)
    private readonly resultRepo: Repository<ScreeningResult>,
    @InjectRepository(WatchlistEntry)
    private readonly watchlistRepo: Repository<WatchlistEntry>,
    private readonly screeningEngine: ScreeningEngine,
  ) {}

  /** Persist a screening outcome. Never throws — see the catch. */
  async record(
    tenantId: string,
    request: ScreeningRequest,
    result: EngineResult,
    opts: { isRescreen?: boolean; previousStatus?: string | null } = {},
  ): Promise<void> {
    try {
      const { customWatchlist, ...storableRequest } = request;
      void customWatchlist; // never stored: it is caller data, not list state

      await this.resultRepo.save(
        this.resultRepo.create({
          tenantId,
          screeningId: result.screeningId,
          entityId: request.entityId ?? null,
          entityName: request.entityName,
          entityType: request.entityType,
          status: result.status,
          riskScore: Math.round(result.riskScore),
          riskLevel: result.riskLevel,
          hitCount: result.hits.length,
          hits: result.hits,
          request: storableRequest as unknown as Record<string, unknown>,
          screenedAt: result.completedAt ?? new Date(),
          watchlistSize: await this.watchlistSize(),
          isRescreen: opts.isRescreen ?? false,
          previousStatus: opts.previousStatus ?? null,
        }),
      );
    } catch (err) {
      // Recording must not fail the screening the caller is waiting on — they
      // still get the correct answer. Logged at ERROR because the consequence
      // is silent: an unrecorded screening is one the rescreen sweep will
      // never revisit, so it expires without anyone noticing.
      this.logger.error(
        `Screening ${result.screeningId} was NOT recorded — it will never be ` +
          `rescreened: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  private watchlistSize(): Promise<number> {
    return TenantContext.runAsSystem('count watchlist', () =>
      this.watchlistRepo.count(),
    );
  }

  /**
   * Rescreen everything whose latest result predates the newest watchlist
   * change.
   *
   * Runs as system: the sweep crosses every tenant by design, and there is no
   * request context to bind. Each screening is still recorded against its own
   * tenantId, so the results stay isolated.
   */
  async sweep(limit = 200): Promise<RescreenSummary> {
    return TenantContext.runAsSystem('scheduled rescreening sweep', async () => {
      const listSize = await this.watchlistRepo.count();

      // Refuse rather than produce reassuring nonsense. With no lists loaded
      // every rescreen would come back clear, overwrite a real prior hit, and
      // report an all-green sweep — actively worse than not running.
      if (listSize === 0) {
        this.logger.error(
          'Rescreen sweep aborted: the watchlist is empty. Rescreening now ' +
            'would clear every existing hit against nothing.',
        );
        return {
          candidates: 0,
          rescreened: 0,
          changed: [],
          skippedReason: 'watchlist_empty',
        };
      }

      const newest = await this.watchlistRepo
        .createQueryBuilder('w')
        .select('MAX(w."lastSeenAt")', 'max')
        .getRawOne<{ max: Date | null }>();

      const listChangedAt = newest?.max ?? null;
      if (!listChangedAt) {
        return {
          candidates: 0,
          rescreened: 0,
          changed: [],
          skippedReason: 'watchlist_has_no_ingest_timestamp',
        };
      }

      // Latest result per (tenant, entity/name) FIRST, and only then discard
      // the ones already newer than the list.
      //
      // The order matters and is not obvious. Filtering inside the DISTINCT ON
      // — `WHERE "screenedAt" < $1` before the de-duplication — selects the
      // newest row *among the stale ones*, so a record that has just been
      // rescreened is skipped over and its original stale row is picked again.
      // The effect is a record that is re-screened and re-alerted on every
      // single sweep, forever: an operator would be paged daily about a change
      // they already actioned, which is how alerts stop being read.
      //
      // DISTINCT ON rather than a correlated subquery keeps this one pass; a
      // sweep that walks every screening ever performed does not finish inside
      // a serverless invocation.
      const candidates: ScreeningResult[] = await this.resultRepo.query(
        `SELECT * FROM (
           SELECT DISTINCT ON ("tenantId", COALESCE("entityId"::text, "entityName")) *
             FROM screening_results
            ORDER BY "tenantId",
                     COALESCE("entityId"::text, "entityName"),
                     "screenedAt" DESC
         ) latest
          WHERE latest."screenedAt" < $1
          LIMIT $2`,
        [listChangedAt, limit],
      );

      const changed: RescreenSummary['changed'] = [];
      let rescreened = 0;

      for (const prior of candidates) {
        const request = {
          ...(prior.request as unknown as ScreeningRequest),
          tenantId: prior.tenantId,
          entityId: prior.entityId ?? undefined,
          entityName: prior.entityName,
        } as ScreeningRequest;

        try {
          const result = await this.screeningEngine.screen(request);
          await this.record(prior.tenantId, request, result, {
            isRescreen: true,
            previousStatus: prior.status,
          });
          rescreened++;

          if (result.status !== prior.status) {
            changed.push({
              tenantId: prior.tenantId,
              entityId: prior.entityId,
              entityName: prior.entityName,
              from: prior.status,
              to: result.status,
            });
            // Logged loudly and per-record. A previously-clear name that now
            // hits is the single output of this job that someone must act on,
            // and burying it in an aggregate count is how it gets missed.
            this.logger.warn(
              `RESCREEN STATUS CHANGE tenant=${prior.tenantId} ` +
                `entity=${prior.entityId ?? prior.entityName} ` +
                `${prior.status} -> ${result.status}`,
            );
          }
        } catch (err) {
          // One bad record must not abort the sweep; the rest still need
          // checking.
          this.logger.error(
            `Rescreen failed for ${prior.entityName}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }

      return { candidates: candidates.length, rescreened, changed };
    });
  }
}
