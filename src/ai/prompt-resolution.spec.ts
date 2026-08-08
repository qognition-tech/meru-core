import {
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AiService } from './ai.service';
import { AiPrompt, AiEmbedding, PromptCategory } from './entities/ai-prompt.entity';
import { CrmService } from '../crm/crm.service';
import { WorkflowEngineService } from '../workflow/workflow.service';
import { TaskService } from '../tasks/task.service';
import { FormBuilderService } from '../forms/form-builder.service';
import { DocumentsService } from '../documents/documents.service';
import { BillingService } from '../billing/billing.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';
import { ConnectorsService } from '../integrations/services/connectors.service';

/**
 * Regression cover for the defect this fixed: `POST /ai/execute` answered
 * `500 Prompt not found` for every tenant on production, because `ai_prompts`
 * is a per-tenant table that nothing ever seeded, and a bare `Error` became a
 * 500.
 *
 * These tests pin three things:
 *  1. a tenant with zero rows still resolves, from the vertical's config pack;
 *  2. a tenant row wins over the pack, so the override still works;
 *  3. an unresolvable prompt is a 503 or a 404 depending on why — never a 500.
 *
 * OPENAI_API_KEY is deliberately left unset, so a successful resolution ends in
 * `ServiceUnavailableException` from `executeOpenAI`. That is the assertion:
 * reaching the model-not-configured error proves resolution succeeded, and it
 * keeps the test from needing a network call.
 */
describe('AiService prompt resolution', () => {
  const promptFindOne = jest.fn();
  const sectionWithPack = jest.fn();
  const resolveAiProvider = jest.fn();
  let service: AiService;

  const packPrompt = (over: Record<string, unknown> = {}) => ({
    key: 'entity_summary',
    category: 'entity_analysis',
    prompt: 'Summarise: {{INPUT}}',
    provider: 'openai',
    requireCitations: true,
    isCategoryDefault: true,
    ...over,
  });

  beforeEach(async () => {
    promptFindOne.mockReset();
    sectionWithPack.mockReset();
    resolveAiProvider.mockReset();
    resolveAiProvider.mockResolvedValue(null);
    delete process.env.OPENAI_API_KEY;

    const stub = {};
    const moduleRef = await Test.createTestingModule({
      providers: [
        AiService,
        {
          provide: getRepositoryToken(AiPrompt),
          useValue: { findOne: promptFindOne, find: jest.fn() },
        },
        { provide: getRepositoryToken(AiEmbedding), useValue: {} },
        { provide: CrmService, useValue: stub },
        { provide: WorkflowEngineService, useValue: stub },
        { provide: TaskService, useValue: stub },
        { provide: FormBuilderService, useValue: stub },
        { provide: DocumentsService, useValue: stub },
        { provide: BillingService, useValue: stub },
        { provide: AnalyticsService, useValue: stub },
        { provide: AuditService, useValue: stub },
        { provide: VerticalPackService, useValue: { sectionWithPack } },
        // No tenant AI provider connected, so resolution falls through to the
        // platform client — which is unset here, and that is the assertion.
        {
          provide: ConnectorsService,
          useValue: { resolveAiProvider: resolveAiProvider },
        },
      ],
    }).compile();

    service = moduleRef.get(AiService);
  });

  it('resolves from the config pack when the tenant has no prompt rows', async () => {
    promptFindOne.mockResolvedValue(null);
    sectionWithPack.mockResolvedValue({
      pack: { code: 'au-immigration' },
      section: [packPrompt()],
    });

    // Resolution succeeded iff we get as far as "no model configured".
    await expect(
      service.execute({
        category: PromptCategory.ENTITY_ANALYSIS,
        input: 'hello',
        tenantId: 't1',
      }),
    ).rejects.toThrow(/no AI provider connected/);
  });

  it('prefers a tenant row over the pack entry', async () => {
    promptFindOne.mockResolvedValue({
      key: 'entity_summary',
      prompt: 'TENANT OVERRIDE {{INPUT}}',
      preferredProvider: 'openai',
      modelConfig: {},
    });

    await expect(
      service.execute({
        category: PromptCategory.ENTITY_ANALYSIS,
        input: 'hello',
        tenantId: 't1',
      }),
    ).rejects.toThrow(/no AI provider connected/);

    // The pack must not even be consulted — otherwise an override is only a
    // preference and the precedence is untested.
    expect(sectionWithPack).not.toHaveBeenCalled();
  });

  it('503s, naming the pack, when nothing anywhere defines prompts', async () => {
    promptFindOne.mockResolvedValue(null);
    sectionWithPack.mockResolvedValue({
      pack: { code: 'au-immigration' },
      section: [],
    });

    const call = service.execute({
      category: PromptCategory.ENTITY_ANALYSIS,
      input: 'hello',
      tenantId: 't1',
    });

    // 503 because the deployment is unconfigured, not 500 because something
    // crashed, and not 404 because the caller asked for something sensible.
    await expect(call).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(call).rejects.toThrow(/au-immigration/);
  });

  it('404s when the library exists but does not contain the requested key', async () => {
    promptFindOne.mockResolvedValue(null);
    sectionWithPack.mockResolvedValue({
      pack: { code: 'au-immigration' },
      section: [packPrompt()],
    });

    await expect(
      service.execute({
        category: PromptCategory.ENTITY_ANALYSIS,
        key: 'no_such_prompt',
        input: 'hello',
        tenantId: 't1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('never surfaces a bare 500 for an unresolvable prompt', async () => {
    promptFindOne.mockResolvedValue(null);
    sectionWithPack.mockResolvedValue({ pack: null, section: null });

    // This is the exact shape of the production failure: no pack, no rows.
    const error = await service
      .execute({
        category: PromptCategory.ENTITY_ANALYSIS,
        input: 'hello',
        tenantId: 't1',
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    // A plain `Error` is what the filter rendered as 500. Asserting the type
    // rather than the message is what stops that regressing.
    expect((error as Error).constructor).not.toBe(Error);
  });

  it('falls back to the first prompt in a category when no default is flagged', async () => {
    promptFindOne.mockResolvedValue(null);
    sectionWithPack.mockResolvedValue({
      pack: { code: 'ae-banking' },
      section: [
        packPrompt({ key: 'first', isCategoryDefault: false }),
        packPrompt({ key: 'second', isCategoryDefault: false }),
      ],
    });

    // A pack that forgot the flag should still answer rather than 404 on a
    // prompt it plainly contains.
    await expect(
      service.execute({
        category: PromptCategory.ENTITY_ANALYSIS,
        input: 'hello',
        tenantId: 't1',
      }),
    ).rejects.toThrow(/no AI provider connected/);
  });
});
