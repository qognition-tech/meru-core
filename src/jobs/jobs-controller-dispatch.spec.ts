import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JobsController } from './jobs.controller';
import { CronSecretGuard } from './cron-secret.guard';

/**
 * ADR 0009 §2.3's extraction must not weaken the machine front door it
 * leaves behind. Two claims pinned here:
 *
 *  1. `CronSecretGuard` is still the class-level guard on `JobsController`
 *     — the extraction must not have dropped or swapped it while moving
 *     `handlerFor`/`run`/`runNamed` out to `JobDispatchService`.
 *  2. `runJobGet`/`runJobPost` are one-line delegations to
 *     `JobDispatchService.runNamed`, and `tick()` calls the same method
 *     rather than re-implementing dispatch — and, because
 *     `JobDispatchService.runNamed` already calls `JobRunService.record()`
 *     internally (see `job-dispatch.service.spec.ts`), `tick()` must NOT
 *     also call `jobRunService.record()` itself, or every job dispatched
 *     through a tick would be recorded twice.
 */
describe('JobsController — extraction preserves the machine front door', () => {
  it('keeps CronSecretGuard as the class-level guard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, JobsController) as
      | unknown[]
      | undefined;
    expect(guards).toContain(CronSecretGuard);
  });

  it('runJobGet delegates to JobDispatchService.runNamed', async () => {
    const runNamed = jest.fn().mockResolvedValue({
      job: 'sla-watchdog',
      status: 'ok',
      durationMs: 1,
    });
    const controller = new JobsController(
      undefined as any, // migrateService
      { lastRunMap: jest.fn() } as any, // jobRunService
      undefined as any, // configPackLoader
      { runNamed } as any, // jobDispatchService
    );

    const result = await controller.runJobGet('sla-watchdog');

    expect(runNamed).toHaveBeenCalledWith('sla-watchdog');
    expect(result.job).toBe('sla-watchdog');
  });

  it('runJobPost delegates to JobDispatchService.runNamed', async () => {
    const runNamed = jest.fn().mockResolvedValue({
      job: 'sla-watchdog',
      status: 'ok',
      durationMs: 1,
    });
    const controller = new JobsController(
      undefined as any,
      { lastRunMap: jest.fn() } as any,
      undefined as any,
      { runNamed } as any,
    );

    await controller.runJobPost('sla-watchdog');
    expect(runNamed).toHaveBeenCalledWith('sla-watchdog');
  });

  it('tick() dispatches every due job through JobDispatchService.runNamed exactly once, and never calls jobRunService.record itself', async () => {
    const runNamed = jest.fn().mockImplementation((job: string) =>
      Promise.resolve({ job, status: 'ok', durationMs: 1 }),
    );
    const record = jest.fn();
    const controller = new JobsController(
      undefined as any,
      { lastRunMap: jest.fn().mockResolvedValue(new Map()), record } as any,
      undefined as any,
      { runNamed } as any,
    );

    const result = await controller.tickGet('fast');

    // Every "fast" job ran, each exactly once, and none were double-recorded
    // by the controller itself — JobDispatchService already recorded them.
    expect(runNamed).toHaveBeenCalledTimes(result.ran.length);
    expect(record).not.toHaveBeenCalled();
    expect(result.ran.length).toBeGreaterThan(0);
    expect(result.failed).toEqual([]);
  });
});
