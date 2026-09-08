import { Controller, Get, Param, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PolicyGuard } from './guards/policy.guard';
import { Roles } from './decorators/roles.decorator';
import { PlatformRole } from './enums/platform-role.enum';
import { TenancyService } from '../core/tenancy/tenancy.service';
import { DocumentAccessService } from '../documents/document-access.service';
import type { AuthenticatedRequest } from '../common/types';

/**
 * `GET /platform/tenants/:id/documents` — ADR 0009 §2.3, adopting ADR 0007
 * D7 unchanged: platform_admin, runAsGod, metadata only, never bytes.
 *
 * **Why this is not a method on `PlatformController`, despite the ADR's
 * prose literally saying "on PlatformController".** `PlatformController`
 * lives inside `IamModule`. `DocumentAccessService.listMetadataForTenant`
 * lives in `DocumentsModule`, and `DocumentsModule` already imports
 * `IamModule` directly (`documents.module.ts`, not `forwardRef`'d — its
 * `forwardRef`s are reserved for `OrchestrationModule`/`AiModule`, which
 * *do* import it back). Having `IamModule` import `DocumentsModule` in turn
 * closes exactly the cycle shape `CLAUDE.md` §8.2 already names as the cause
 * of one production `FUNCTION_INVOCATION_FAILED` (`DocumentsModule` →
 * `RulesModule`), and it is the identical class of oversight this same ADR
 * corrects for the job-runner route in §2.3's second half (see
 * `job-dispatch.service.ts` and `platform-jobs.controller.ts`) — a bad
 * citation from ADR 0007 that this file's own reasoning would otherwise
 * repeat one section later. Flagged rather than silently diverged from: see
 * the implementation report for this contract.
 *
 * The fix is the same one already proven in this codebase for the identical
 * problem: `OperatorController` (`operator.controller.ts`) needed
 * `BrandingService`/`ConnectorsService` from modules that also import
 * `IamModule`, and solved it by living in its own module
 * (`OperatorModule`) that imports `IamModule` rather than the reverse. This
 * controller does the same — it is registered in `OperatorModule`, not
 * `IamModule` — and keeps `PlatformController`'s own module membership
 * (and therefore `IamModule`'s import graph) untouched. URL shape is
 * unaffected: `@Controller('platform')` here reproduces the exact path
 * `PlatformController` would have served, which is what the dashboard's
 * `notImplemented("GET /platform/tenants/:id/documents", [])` stub
 * (`meru-dashboard/app/platform/tenants/[id]/page.tsx:266-296`) already
 * calls.
 */
@ApiTags('platform')
@Controller('platform')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class PlatformDocumentsController {
  constructor(
    private readonly tenancyService: TenancyService,
    private readonly documentAccessService: DocumentAccessService,
  ) {}

  @Get('tenants/:id/documents')
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiOperation({
    summary: "Another tenant's document inventory, metadata only (God View)",
    description:
      'platform_admin only, audited via runAsGod. Never returns `s3Url`, ' +
      '`rbac` or `aiAnalysis` — an operator inventory has no legitimate ' +
      "need to open a client's passport scan (CLAUDE.md §5.1b). Rendering " +
      'the operator’s own tenant’s documents as if they were the target’s ' +
      "would be the \"unknown rendered as a positive result\" failure " +
      'CLAUDE.md §5.2 bans, which is why this route exists instead of the ' +
      'God UI reusing GET /documents against an impersonation token.',
  })
  @ApiParam({ name: 'id', description: 'Tenant id' })
  @ApiResponse({ status: 200, description: 'Document metadata retrieved' })
  @ApiResponse({ status: 403, description: 'Requires platform_admin' })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  documents(@Request() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.tenancyService.runAsGod(
      req.user.id,
      id,
      `Read document metadata for tenant ${id} (God View)`,
      () => this.documentAccessService.listMetadataForTenant(id),
    );
  }
}
