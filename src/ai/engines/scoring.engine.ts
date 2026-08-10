import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { RuleEvaluatorService } from '../../rules/rule-evaluator.service';
import { VerticalPackService } from '../../tenant/services/vertical-pack.service';

/** One `scoringModels[]` entry, as the pack declares it. */
export interface ScoringModelDefinition {
  key: string;
  label: string;
  entityType: string;
  factors: Array<{
    key: string;
    label: string;
    when: unknown;
    weight: number;
  }>;
  bands?: Array<{
    key: string;
    label: string;
    minScore: number;
    color?: string;
  }>;
}

export interface ScoreResult {
  modelKey: string;
  label: string;
  score: number;
  /** Highest possible score for this model, so a raw score is interpretable. */
  maxScore: number;
  band: { key: string; label: string; color?: string } | null;
  /**
   * Every factor and whether it fired. Both directions are returned on
   * purpose: "why is this lead a 40?" is answered as much by what did *not*
   * match as by what did, and a score with no explanation is a number nobody
   * is willing to act on.
   */
  contributions: Array<{
    key: string;
    label: string;
    matched: boolean;
    weight: number;
  }>;
}

/**
 * Weighted-factor scoring, driven entirely by the pack.
 *
 * Lead scoring, visa recommendation and generic risk scoring were three
 * separately-named features across the two specs (docs/FEATURE_PARITY_MAP.md
 * §5, item 6). They are one weighted sum plus banding — the only thing that
 * differs is which predicates carry which weight, which is exactly what
 * belongs in Layer 4 rather than in core.
 *
 * Deliberately stateless: it computes and returns. Persisting a score would
 * make it stale the moment the record changed, and a stale risk score that
 * looks current is worse than no score — the same reasoning as the rescreening
 * sweep, where a clear result that has expired is the hazard.
 */
@Injectable()
export class ScoringEngine {
  private readonly logger = new Logger(ScoringEngine.name);

  constructor(
    private readonly evaluator: RuleEvaluatorService,
    private readonly packs: VerticalPackService,
  ) {}

  /** Score one record against one model from the vertical's pack. */
  async score(
    vertical: string | null,
    modelKey: string,
    data: Record<string, unknown>,
  ): Promise<ScoreResult> {
    const model = await this.model(vertical, modelKey);
    return this.apply(model, data);
  }

  /** Every model a vertical defines, for a UI that offers a choice. */
  async list(vertical: string | null): Promise<ScoringModelDefinition[]> {
    return (
      (await this.packs.section<ScoringModelDefinition[]>(
        vertical,
        'scoringModels',
      )) ?? []
    );
  }

  /**
   * The pure part, exposed so a caller that already holds the model (a batch
   * scoring a thousand leads) does not re-read the pack per record.
   */
  apply(
    model: ScoringModelDefinition,
    data: Record<string, unknown>,
  ): ScoreResult {
    const contributions = model.factors.map((factor) => {
      const check = this.evaluator.validate(factor.when);
      if (!check.valid) {
        // A factor that cannot compile scores zero and says so. Throwing
        // would make one bad factor withhold the whole score, and silently
        // dropping it would move every record's score without explanation.
        this.logger.error(
          `Scoring model '${model.key}' factor '${factor.key}' is not ` +
            `evaluable and contributed nothing: ${check.reason}`,
        );
        return {
          key: factor.key,
          label: factor.label,
          matched: false,
          weight: factor.weight,
        };
      }

      return {
        key: factor.key,
        label: factor.label,
        matched: this.evaluator.matches(factor.when, data),
        weight: factor.weight,
      };
    });

    const score = contributions
      .filter((c) => c.matched)
      .reduce((sum, c) => sum + c.weight, 0);

    // Only positive weights can raise a score, so the ceiling ignores
    // penalties — otherwise a model with a -20 penalty would report a maximum
    // no record could ever reach.
    const maxScore = model.factors
      .filter((f) => f.weight > 0)
      .reduce((sum, f) => sum + f.weight, 0);

    return {
      modelKey: model.key,
      label: model.label,
      score,
      maxScore,
      band: this.bandFor(model, score),
      contributions,
    };
  }

  /**
   * The band a score falls in.
   *
   * Bands are evaluated highest threshold first regardless of the order they
   * were authored in, because an author listing them low-to-high would
   * otherwise get the lowest band for every score — a silent wrong answer
   * rather than an error.
   */
  private bandFor(
    model: ScoringModelDefinition,
    score: number,
  ): ScoreResult['band'] {
    const bands = [...(model.bands ?? [])].sort(
      (a, b) => b.minScore - a.minScore,
    );

    const hit = bands.find((b) => score >= b.minScore);
    return hit
      ? { key: hit.key, label: hit.label, color: hit.color }
      : null;
  }

  private async model(
    vertical: string | null,
    modelKey: string,
  ): Promise<ScoringModelDefinition> {
    const models = await this.list(vertical);
    const model = models.find((m) => m.key === modelKey);

    if (!model) {
      throw new BadRequestException(
        `Scoring model '${modelKey}' is not defined in the ` +
          `${vertical ?? 'unknown'} pack` +
          (models.length
            ? ` (available: ${models.map((m) => m.key).join(', ')})`
            : ' — the pack defines no scoring models'),
      );
    }

    return model;
  }
}
