import { NotFoundException } from '@nestjs/common';
import { OrchestrationService } from './orchestration.service';
import { CrmService } from '../crm/crm.service';
import { CrmAccessService } from '../crm/crm-access.service';
import { EntityType, EntityStatus } from '../crm/entities/universal-entity.entity';
import { Actor } from '../common/access';
import { VerticalType } from '../iam/enums/vertical.enum';
import type { AiResponse } from '../ai/ai.service';
import { ModelProvider } from '../ai/entities/ai-prompt.entity';

/**
 * `orchestration` shipped with zero specs, which is exactly how the bug this
 * file exists for went unnoticed: `GET /orchestration/search/intelligent` and
 * `GET /orchestration/entity/:id/insights` carried `@UseGuards(AuthGuard('jwt'),
 * PolicyGuard)` with no `@Roles` — a no-op role check, since `PolicyGuard`
 * only enforces a role list the reflector actually finds — and
 * `extractInsights` reached the entity through the unscoped
 * `CrmService.findEntityById`, which takes no tenant and no actor at all.
 *
 * This suite pins the fix at the service layer: `extractInsights` now goes
 * through `CrmService.getEntity`, which is both tenant- and actor-scoped
 * (`CrmAccessService`, 404-not-403), and `performIntelligentSearch` threads
 * `actor` into `SearchService.search` so `scopeResults` is not a no-op. The
 * controller's `@Roles(STAFF, FIRM_ADMIN)` gate is the first line of defence
 * and is not re-tested here (see the controller's own guard wiring) — this
 * suite is the defence-in-depth layer the task explicitly asked not to skip.
 */
describe('OrchestrationService authorisation', () => {
  const T = 't1';
  const OWNED_ID = 'e-owned';
  const OTHER_ID = 'e-other';

  const ACTORS: Record<string, Actor> = {
    firm_admin: { id: 'staff-1', roles: ['firm_admin'] },
    staff: { id: 'staff-2', roles: ['staff'] },
    'client-own': { id: 'client-a', roles: ['client'] },
    'client-other': { id: 'client-b', roles: ['client'] },
  };

  function buildEntityRepo() {
    const store = new Map<string, any>();
    store.set(OWNED_ID, {
      id: OWNED_ID,
      tenantId: T,
      type: EntityType.LEAD,
      status: EntityStatus.OPEN,
      assignedTo: 'client-a',
      verticalAttributes: { vertical: VerticalType.IMMIGRATION },
    });
    store.set(OTHER_ID, {
      id: OTHER_ID,
      tenantId: T,
      type: EntityType.LEAD,
      status: EntityStatus.OPEN,
      assignedTo: 'client-c',
      verticalAttributes: { vertical: VerticalType.IMMIGRATION },
    });

    return {
      findOne: async ({ where }: any) => {
        let rows = [...store.values()];
        if (where.id !== undefined) rows = rows.filter((r) => r.id === where.id);
        if (where.tenantId !== undefined)
          rows = rows.filter((r) => r.tenantId === where.tenantId);
        return rows[0] ?? null;
      },
    };
  }

  const citedInsights = (): AiResponse => ({
    result: JSON.stringify({ riskLevel: 'medium', completeness: 0.8, actions: [] }),
    model: 'm',
    provider: ModelProvider.OPENAI,
    cached: false,
    sources: [{ url: 'https://example.gov/rule', title: 'Rule' } as any],
    citationEnforced: true,
  });

  function buildService(searchOverride?: { search: jest.Mock }) {
    const access = new CrmAccessService();
    const crm = new CrmService(
      buildEntityRepo() as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      access,
    );
    const search = searchOverride ?? { search: jest.fn().mockResolvedValue([]) };
    const aiService = { analyzeEntity: jest.fn().mockResolvedValue(citedInsights()) };
    const service = new OrchestrationService(crm, search as any, aiService as any);
    return { service, aiService };
  }

  describe('extractInsights', () => {
    it('returns real insights for staff on any record in the tenant', async () => {
      const { service } = buildService();
      const result = await service.extractInsights(T, OTHER_ID, ACTORS.staff);
      expect(result.riskLevel).toBe('medium');
      expect(result.citationEnforced).toBe(true);
    });

    it('returns real insights for a client on their own record', async () => {
      const { service } = buildService();
      const result = await service.extractInsights(T, OWNED_ID, ACTORS['client-own']);
      expect(result.riskLevel).toBe('medium');
    });

    it('withholds insights for a client on a record that is not theirs, without leaking whether it exists', async () => {
      const { service, aiService } = buildService();
      const result = await service.extractInsights(T, OTHER_ID, ACTORS['client-other']);

      // Same "unavailable" shape as a genuinely unanalysable record (§5.2) —
      // never a raw 404 thrown out of this method, and never a positive
      // result rendered off inaccessible data (CLAUDE.md §7.3).
      expect(result.riskLevel).toBeNull();
      expect(result.citationEnforced).toBe(false);
      expect(result.unavailableReason).toMatch(/entity not found/i);
      // The AI was never even asked — the record was refused before that.
      expect(aiService.analyzeEntity).not.toHaveBeenCalled();
    });

    it('a bare platform_admin (not god-mode) is treated as `own` scope, same as a client', async () => {
      const { service } = buildService();
      const bareOperator: Actor = { id: 'op-1', roles: ['platform_admin'] };
      const result = await service.extractInsights(T, OTHER_ID, bareOperator);
      expect(result.riskLevel).toBeNull();
      expect(result.unavailableReason).toMatch(/entity not found/i);
    });
  });

  describe('performIntelligentSearch', () => {
    it('forwards the actor to SearchService.search so own-scope narrowing is not a no-op', async () => {
      const search = { search: jest.fn().mockResolvedValue([]) };
      const { service } = buildService(search);

      await service.performIntelligentSearch(T, 'passport', {}, ACTORS['client-own']);

      expect(search.search).toHaveBeenCalledWith(
        T,
        'passport',
        20,
        ACTORS['client-own'],
      );
    });

    it('still works with no actor for internal callers that are not serving a client request', async () => {
      const search = { search: jest.fn().mockResolvedValue([]) };
      const { service } = buildService(search);

      await service.performIntelligentSearch(T, 'passport', {});

      expect(search.search).toHaveBeenCalledWith(T, 'passport', 20, undefined);
    });
  });
});
