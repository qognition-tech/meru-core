import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { BillingService } from './billing.service';
import { PolicyGuard } from '../iam/guards/policy.guard';
import {
  AddCreditsDto,
  CreatePlanDto,
  CreateSubscriptionDto,
  RecordUsageDto,
} from './dto/billing.dto';
import type { BillingPlan } from './entities/billing-plan.entity';
import { DateRangeQueryDto } from '../common/dto/date-range.dto';

@ApiTags('billing')
@Controller('billing')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class BillingController {
  constructor(private billingService: BillingService) {}

  // ==================== PLANS ====================

  @Post('plans')
  @ApiOperation({ summary: 'Create a billing plan' })
  async createPlan(@Request() req, @Body() dto: CreatePlanDto) {
    // The DTO guarantees the envelope — name present, price a non-negative
    // integer, currency well-formed. The nested shape of `features`/`limits` is
    // plan-configuration data rather than a fixed core schema, so it is carried
    // as an object and asserted here rather than mirrored field-by-field.
    const plan = await this.billingService.createPlan(
      req.user.tenantId,
      dto as Partial<BillingPlan>,
    );
    return plan;
  }

  @Get('plans')
  @ApiOperation({ summary: 'Get all billing plans' })
  @ApiQuery({ name: 'billingModel', required: false })
  async getPlans(@Request() req, @Query('billingModel') billingModel?: string) {
    const plans = await this.billingService.getPlans(
      req.user.tenantId,
      billingModel as any,
    );
    return plans;
  }

  // ==================== SUBSCRIPTIONS ====================

  @Post('subscriptions')
  @ApiOperation({ summary: 'Create a subscription' })
  async createSubscription(@Request() req, @Body() dto: CreateSubscriptionDto) {
    const subscription = await this.billingService.createSubscription(
      req.user.tenantId,
      dto,
    );
    return subscription;
  }

  @Get('subscriptions/:id')
  @ApiOperation({ summary: 'Get subscription details' })
  async getSubscription(@Request() req, @Param('id') id: string) {
    const subscription = await this.billingService.getSubscription(
      id,
      req.user.tenantId,
    );
    return subscription;
  }

  // ==================== USAGE ====================

  @Post('usage')
  @ApiOperation({ summary: 'Record metered usage' })
  async recordUsage(@Request() req, @Body() dto: RecordUsageDto) {
    const usage = await this.billingService.recordUsage(req.user.tenantId, dto);
    return usage;
  }

  // ==================== CREDITS ====================

  @Post('credits')
  @ApiOperation({ summary: 'Add credits to subscription' })
  async addCredits(@Request() req, @Body() dto: AddCreditsDto) {
    // `expiryDate` arrives as an ISO string (that is what IsDateString
    // validates) and the service takes a Date. Converting here keeps an
    // unparseable value from reaching Postgres as a literal.
    const credit = await this.billingService.addCredits(req.user.tenantId, {
      ...dto,
      expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : undefined,
    });
    return credit;
  }

  @Get('subscriptions/:id/credits/balance')
  @ApiOperation({ summary: 'Get credit balance' })
  async getCreditBalance(@Request() req, @Param('id') id: string) {
    const balance = await this.billingService.getCreditBalance(id);
    return { balance };
  }

  // ==================== INVOICES ====================

  @Post('invoices/generate')
  @ApiOperation({ summary: 'Generate invoice for period' })
  async generateInvoice(
    @Request() req,
    @Body() dto: { subscriptionId: string; periodStart: Date; periodEnd: Date },
  ) {
    const invoice = await this.billingService.generateInvoice(
      dto.subscriptionId,
      new Date(dto.periodStart),
      new Date(dto.periodEnd),
    );
    return invoice;
  }

  // ==================== ANALYTICS ====================

  @Get('metrics')
  @ApiOperation({ summary: 'Get billing metrics' })
  @ApiQuery({ name: 'startDate', required: true })
  @ApiQuery({ name: 'endDate', required: true })
  async getMetrics(@Request() req, @Query() range: DateRangeQueryDto) {
    const metrics = await this.billingService.getBillingMetrics(
      req.user.tenantId,
      new Date(range.startDate),
      new Date(range.endDate),
    );
    return metrics;
  }
}
