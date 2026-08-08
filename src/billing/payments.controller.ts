import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { Roles } from '../iam/decorators/roles.decorator';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { PaymentsService } from './payments.service';
import {
  CreatePaymentDto,
  ListPaymentsQueryDto,
  SettlePaymentDto,
} from './dto/payment.dto';
import { paginated } from '../common/paginated';
import type { AuthenticatedRequest } from '../common/types';

/**
 * The firm's receivables — what its clients owe it.
 *
 * Distinct resource from `/billing`, which is Meru charging the firm. They
 * were conflated before, which is how the ImmiStack client portal ended up
 * with no ledger at all: `/billing/checkout` is admin-only and buys the
 * firm's Meru tier, so it could never have served a client.
 */
@ApiTags('payments')
@Controller('payments')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * A `client` is the person being billed, not staff: they see only their own
   * rows. RLS isolates one tenant from another and does NOT isolate users
   * within a tenant, so this restriction is the only thing separating two
   * applicants of the same firm. Forced rather than defaulted — a client
   * cannot widen it by passing `?clientId=` for somebody else.
   *
   * Mirrors the CRM fix in 32147ed deliberately: the same shape of bug, in a
   * resource where the leak would be someone's finances.
   */
  private clientScope(req: AuthenticatedRequest): string | null {
    const roles = req.user.roles ?? [];
    const isStaff = roles.some((r) =>
      [
        PlatformRole.PLATFORM_ADMIN,
        PlatformRole.FIRM_ADMIN,
        PlatformRole.STAFF,
      ].includes(r as PlatformRole),
    );
    return roles.includes(PlatformRole.CLIENT) && !isStaff ? req.user.id : null;
  }

  @Get()
  @ApiOperation({
    summary: "The caller's payment ledger",
    description:
      'Staff see the whole firm and may filter by ?clientId=. A client-role ' +
      'caller is forced to their own rows regardless of query. For ledger ' +
      'totals use GET /payments/summary — they cannot ride on this response, ' +
      'because the envelope replaces a paginated payload with its items array.',
  })
  @ApiResponse({ status: 200, description: 'Payments retrieved' })
  async list(
    @Request() req: AuthenticatedRequest,
    @Query() query: ListPaymentsQueryDto,
  ) {
    const { items, total, page, limit } = await this.paymentsService.list(
      req.user.tenantId,
      query,
      this.clientScope(req),
    );
    return paginated(items, total, page, limit);
  }

  /**
   * Declared before `:id` on purpose. Express matches in registration order,
   * so a `:id` route placed first would capture "summary" and answer 400 from
   * ParseUUIDPipe — a confusing failure for a route that plainly exists.
   */
  @Get('summary')
  @ApiOperation({
    summary: 'Ledger totals by currency and status',
    description:
      'Summed in SQL over the whole filtered ledger, not the current page — ' +
      'a client portal shows this as "outstanding". Grouped by currency ' +
      'because a total across mixed currencies means nothing. Client-role ' +
      'callers are scoped to their own rows, same as the list.',
  })
  @ApiResponse({ status: 200, description: 'Totals retrieved' })
  async summary(
    @Request() req: AuthenticatedRequest,
    @Query() query: ListPaymentsQueryDto,
  ) {
    return this.paymentsService.summary(
      req.user.tenantId,
      query,
      this.clientScope(req),
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One payment',
    description:
      "A client requesting another client's payment gets 404, not 403 — a " +
      '403 would confirm the row exists.',
  })
  @ApiParam({ name: 'id', description: 'Payment id' })
  @ApiResponse({ status: 200, description: 'Payment retrieved' })
  @ApiResponse({ status: 404, description: 'Not found, or not yours' })
  async findOne(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.paymentsService.findOne(
      req.user.tenantId,
      id,
      this.clientScope(req),
    );
  }

  @Post()
  @Roles(
    PlatformRole.PLATFORM_ADMIN,
    PlatformRole.FIRM_ADMIN,
    PlatformRole.STAFF,
  )
  @ApiOperation({
    summary: 'Raise a charge against a client',
    description:
      'Staff only — a client cannot invoice themselves. Amount is in MINOR ' +
      'units (cents/fils/pence) and must be a positive integer; a decimal is ' +
      'rejected rather than rounded.',
  })
  @ApiResponse({ status: 201, description: 'Payment created' })
  @ApiResponse({ status: 400, description: 'Invalid amount or currency' })
  @ApiResponse({ status: 403, description: 'Requires a staff role' })
  async create(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreatePaymentDto,
  ) {
    return this.paymentsService.create(req.user.tenantId, dto);
  }

  @Patch(':id/settle')
  @Roles(
    PlatformRole.PLATFORM_ADMIN,
    PlatformRole.FIRM_ADMIN,
    PlatformRole.STAFF,
  )
  @ApiOperation({
    summary: 'Record that a payment settled outside Meru',
    description:
      'Bank transfer, card terminal, trust account. No processor is called: ' +
      "Stripe in this platform is Meru billing the firm, not the firm " +
      'billing its clients. Transitions are constrained — paid → refunded ' +
      'only, and refunded/cancelled are terminal, so the ledger stays ' +
      'reconcilable.',
  })
  @ApiParam({ name: 'id', description: 'Payment id' })
  @ApiResponse({ status: 200, description: 'Payment updated' })
  @ApiResponse({ status: 400, description: 'Illegal status transition' })
  @ApiResponse({ status: 403, description: 'Requires a staff role' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async settle(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SettlePaymentDto,
  ) {
    return this.paymentsService.settle(req.user.tenantId, id, dto);
  }
}
