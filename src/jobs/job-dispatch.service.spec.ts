import { NotFoundException } from '@nestjs/common';
import { JobDispatchService } from './job-dispatch.service';

/**
 * `JobDispatchService.runNamed` (ADR 0009 §2.3) is the one implementation
 * both `JobsController` (machine, `CronSecretGuard`) and
 * `PlatformJobsController` (human, `platform_admin`) call — "one job
 * implementation, two front doors" only holds if this method actually
 * dispatches to the right handler and actually records the outcome, on both
 * success and failure, exactly once.
 */
describe('JobDispatchService.runNamed', () => {
  const checkSLAViolations = jest.fn().mockResolvedValue({ checked: 3 });
  const record = jest.fn().mockResolvedValue(undefined);

  const make = () =>
    new JobDispatchService(
      { checkSLAViolations } as any, // slaWatchdogService
      undefined as any, // alertRuleService
      undefined as any, // sequenceRunner
      undefined as any, // billingService
      undefined as any, // queueService
      undefined as any, // jobProcessor
      undefined as any, // taskService
      undefined as any, // notificationsService
      undefined as any, // analyticsService
      undefined as any, // retentionService
      undefined as any, // regulatoryRadar
      { record } as any, // jobRunService
      undefined as any, // rescreeningService
      undefined as any, // notificationDispatch
      undefined as any, // watchlistIngest
      undefined as any, // screeningEngine
    );

  beforeEach(() => {
    checkSLAViolations.mockClear();
    record.mockClear();
  });

  it('404s on an unrecognised job name — the fail-closed check both front doors rely on', async () => {
    await expect(make().runNamed('not-a-real-job')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('dispatches a known job to its handler and records success', async () => {
    const result = await make().runNamed('sla-watchdog');

    expect(checkSLAViolations).toHaveBeenCalledTimes(1);
    expect(result.job).toBe('sla-watchdog');
    expect(result.status).toBe('ok');
    expect(record).toHaveBeenCalledWith(
      'sla-watchdog',
      expect.objectContaining({ status: 'ok' }),
    );
  });

  it('records failure and rethrows when the handler throws', async () => {
    checkSLAViolations.mockRejectedValueOnce(new Error('db unreachable'));

    await expect(make().runNamed('sla-watchdog')).rejects.toThrow();
    expect(record).toHaveBeenCalledWith(
      'sla-watchdog',
      expect.objectContaining({ status: 'failed' }),
    );
  });
});
