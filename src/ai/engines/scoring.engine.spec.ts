import { ScoringEngine, type ScoringModelDefinition } from './scoring.engine';
import { RuleEvaluatorService } from '../../rules/rule-evaluator.service';
import { BadRequestException } from '@nestjs/common';

describe('ScoringEngine', () => {
  const model: ScoringModelDefinition = {
    key: 'lead_score',
    label: 'Lead score',
    entityType: 'lead',
    factors: [
      {
        key: 'has_sponsor',
        label: 'Has a sponsoring employer',
        when: { var: 'sponsorId' },
        weight: 30,
      },
      {
        key: 'skilled_occupation',
        label: 'Occupation on the skilled list',
        when: { var: 'occupationOnList' },
        weight: 25,
      },
      {
        key: 'english_test',
        label: 'English test complete',
        when: { '>=': [{ var: 'ieltsScore' }, 6] },
        weight: 20,
      },
      {
        key: 'previous_refusal',
        label: 'Previous visa refusal',
        when: { var: 'previousRefusal' },
        weight: -15,
      },
    ],
    // Deliberately authored low-to-high, which is the order a person writes
    // them in and the order that would break a naive first-match.
    bands: [
      { key: 'cold', label: 'Cold', minScore: 0 },
      { key: 'warm', label: 'Warm', minScore: 40 },
      { key: 'hot', label: 'Hot', minScore: 70 },
    ],
  };

  function build(models: ScoringModelDefinition[] = [model]) {
    const packs = { section: jest.fn(() => Promise.resolve(models)) };
    return new ScoringEngine(new RuleEvaluatorService(), packs as never);
  }

  it('sums the weights of the factors that match', async () => {
    const engine = build();

    const result = await engine.score('immigration', 'lead_score', {
      sponsorId: 'abc',
      occupationOnList: true,
      ieltsScore: 7,
    });

    expect(result.score).toBe(75);
    expect(result.band?.key).toBe('hot');
  });

  it('applies a negative weight as a penalty', async () => {
    const engine = build();

    const result = await engine.score('immigration', 'lead_score', {
      sponsorId: 'abc',
      occupationOnList: true,
      previousRefusal: true,
    });

    expect(result.score).toBe(40);
    expect(result.band?.key).toBe('warm');
  });

  it('reports the ceiling excluding penalties', async () => {
    const engine = build();

    const result = await engine.score('immigration', 'lead_score', {});

    // 30 + 25 + 20. Including the -15 would report a maximum no record could
    // reach, which makes the score uninterpretable.
    expect(result.maxScore).toBe(75);
    expect(result.score).toBe(0);
    expect(result.band?.key).toBe('cold');
  });

  it('bands highest-threshold-first whatever order they were authored in', async () => {
    const engine = build();

    // A naive first-match over the authored order returns "cold" for every
    // score, because every score is >= 0. Silent wrong answer, not an error.
    const result = await engine.score('immigration', 'lead_score', {
      sponsorId: 'abc',
      occupationOnList: true,
      ieltsScore: 8,
    });
    expect(result.band?.key).toBe('hot');
  });

  it('explains itself: every factor, matched or not', async () => {
    const engine = build();

    const result = await engine.score('immigration', 'lead_score', {
      sponsorId: 'abc',
    });

    // "Why is this lead a 30?" is answered as much by what did not match.
    expect(result.contributions).toHaveLength(4);
    expect(result.contributions.filter((c) => c.matched).map((c) => c.key)).toEqual([
      'has_sponsor',
    ]);
  });

  it('scores an uncompilable factor as zero rather than withholding the score', async () => {
    const engine = build([
      {
        ...model,
        factors: [
          { key: 'bad', label: 'Bad', when: { exec: ['x'] }, weight: 50 },
          ...model.factors,
        ],
      },
    ]);

    const result = await engine.score('immigration', 'lead_score', {
      sponsorId: 'abc',
    });

    // Throwing would let one bad factor withhold the whole score; silently
    // dropping it would move every record's score with no explanation.
    expect(result.score).toBe(30);
    expect(result.contributions[0]).toMatchObject({ key: 'bad', matched: false });
  });

  it('returns no band when the score falls below every threshold', async () => {
    const engine = build([
      { ...model, bands: [{ key: 'hot', label: 'Hot', minScore: 70 }] },
    ]);

    const result = await engine.score('immigration', 'lead_score', {});
    expect(result.band).toBeNull();
  });

  it('names the available models when one is not defined', async () => {
    const engine = build();

    await expect(
      engine.score('immigration', 'no_such_model', {}),
    ).rejects.toThrow(BadRequestException);
    await expect(
      engine.score('immigration', 'no_such_model', {}),
    ).rejects.toThrow(/lead_score/);
  });

  it('reads vertical attributes without the caller flattening them', async () => {
    const engine = build();

    const result = await engine.score('immigration', 'lead_score', {
      verticalAttributes: { sponsorId: 'abc', ieltsScore: 7 },
    });

    expect(result.score).toBe(50);
  });
});
