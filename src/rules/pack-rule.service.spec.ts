import { Test } from '@nestjs/testing';
import { PackRuleService } from './pack-rule.service';
import { RuleEvaluatorService } from './rule-evaluator.service';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';

describe('PackRuleService', () => {
  let service: PackRuleService;
  const sectionWithPack = jest.fn();

  beforeEach(async () => {
    sectionWithPack.mockReset();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PackRuleService,
        RuleEvaluatorService,
        { provide: VerticalPackService, useValue: { sectionWithPack } },
      ],
    }).compile();
    service = moduleRef.get(PackRuleService);
  });

  const pack = { code: 'immigration', version: '2.3.0' };

  it('reports a matching error rule as a violation and blocks', async () => {
    sectionWithPack.mockResolvedValue({
      pack,
      section: [
        {
          key: 'minor-applicant',
          label: 'Applicant is a minor',
          when: { '<': [{ var: 'age' }, 18] },
          message: 'Applicant is {{age}}; a guardian must sign.',
        },
      ],
    });

    const report = await service.evaluate('immigration', {
      id: 'e1',
      verticalAttributes: { age: 16 },
    });

    expect(report.pack).toEqual(pack);
    expect(report.evaluated).toBe(1);
    expect(report.blocked).toBe(true);
    expect(report.violations[0]).toMatchObject({
      key: 'minor-applicant',
      severity: 'error',
      message: 'Applicant is 16; a guardian must sign.',
    });
  });

  it('never treats a rule over a missing field as passed', async () => {
    sectionWithPack.mockResolvedValue({
      pack,
      section: [
        {
          key: 'expiring',
          label: 'Expires soon',
          when: { '<': [{ var: 'daysToExpiry' }, 90] },
        },
      ],
    });

    const report = await service.evaluate('immigration', { id: 'e1' });

    // `null < 90` is true in JavaScript. This is the bug that once fired
    // "expires within 90 days" on every record with no expiry date.
    expect(report.evaluated).toBe(0);
    expect(report.skipped).toEqual([
      { key: 'expiring', reason: 'record does not carry daysToExpiry' },
    ]);
    expect(report.violations).toEqual([]);
    expect(report.blocked).toBe(false);
  });

  it('surfaces an uncompilable rule as invalid rather than throwing', async () => {
    sectionWithPack.mockResolvedValue({
      pack,
      section: [{ key: 'bad', label: 'Bad', when: null }],
    });
    const report = await service.evaluate('immigration', { id: 'e1' });
    expect(report.invalid).toHaveLength(1);
    expect(report.invalid[0].key).toBe('bad');
  });

  it('does not block on warning severity', async () => {
    sectionWithPack.mockResolvedValue({
      pack,
      section: [
        {
          key: 'w',
          label: 'W',
          severity: 'warning',
          when: { '==': [{ var: 'status' }, 'open'] },
        },
      ],
    });
    const report = await service.evaluate('grc', { status: 'open' });
    expect(report.violations).toHaveLength(1);
    expect(report.blocked).toBe(false);
  });

  it('is empty, not an error, for a vertical with no pack', async () => {
    sectionWithPack.mockResolvedValue({ pack: null, section: null });
    const report = await service.evaluate('labour', { id: 'e1' });
    expect(report).toMatchObject({ pack: null, evaluated: 0, violations: [] });
  });
});
