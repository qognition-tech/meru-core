import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Between } from 'typeorm';
import {
  BillingPlan,
  BillingModel,
  PlanInterval,
} from './entities/billing-plan.entity';
import {
  Subscription,
  SubscriptionStatus,
} from './entities/subscription.entity';
import { UsageRecord, UsageType } from './entities/usage-record.entity';
import {
  CreditLedger,
  CreditTransactionType,
} from './entities/credit-ledger.entity';
import { Invoice, InvoiceStatus } from './entities/invoice.entity';
import { InvoiceItem, InvoiceItemType } from './entities/invoice-item.entity';
import { Cron, CronExpression } from '@nestjs/schedule';

export interface CreateSubscriptionDto {
  entityId: string;
  entityType: string;
  planId: string;
  trialDays?: number;
  metadata?: Record<string, any>;
}

export interface RecordUsageDto {
  subscriptionId: string;
  usageType: UsageType;
  quantity: number;
  description?: string;
  metadata?: Record<string, any>;
}

export interface AddCreditsDto {
  subscriptionId: string;
  amount: number;
  description: string;
  expiryDate?: Date;
  metadata?: Record<string, any>;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @InjectRepository(BillingPlan)
    private planRepo: Repository<BillingPlan>,
    @InjectRepository(Subscription)
    private subscriptionRepo: Repository<Subscription>,
    @InjectRepository(UsageRecord)
    private usageRepo: Repository<UsageRecord>,
    @InjectRepository(CreditLedger)
    private creditRepo: Repository<CreditLedger>,
    @InjectRepository(Invoice)
    private invoiceRepo: Repository<Invoice>,
    @InjectRepository(InvoiceItem)
    private invoiceItemRepo: Repository<InvoiceItem>,
    private dataSource: DataSource,
  ) {}

  // ==================== BILLING PLANS ====================

  async createPlan(
    tenantId: string,
    dto: Partial<BillingPlan>,
  ): Promise<BillingPlan> {
    const plan = this.planRepo.create({
      tenantId,
      ...dto,
    });

    const saved = await this.planRepo.save(plan);
    this.logger.log(`Billing plan created: ${saved.id}`);
    return saved;
  }

  async getPlans(
    tenantId: string,
    billingModel?: BillingModel,
  ): Promise<BillingPlan[]> {
    const where: any = { tenantId, status: 'active' };
    if (billingModel) {
      where.billingModel = billingModel;
    }

    return this.planRepo.find({ where });
  }

  // ==================== SUBSCRIPTIONS ====================

  async createSubscription(
    tenantId: string,
    dto: CreateSubscriptionDto,
  ): Promise<Subscription> {
    const plan = await this.planRepo.findOne({
      where: { id: dto.planId, tenantId },
    });

    if (!plan) {
      throw new NotFoundException('Billing plan not found');
    }

    const now = new Date();
    const trialEndsAt = dto.trialDays
      ? new Date(now.getTime() + dto.trialDays * 24 * 60 * 60 * 1000)
      : null;

    const currentPeriodEnd = this.calculatePeriodEnd(now, plan.interval);

    const subscription = this.subscriptionRepo.create({
      tenantId,
      entityId: dto.entityId,
      entityType: dto.entityType,
      planId: dto.planId,
      status: trialEndsAt
        ? SubscriptionStatus.TRIALING
        : SubscriptionStatus.ACTIVE,
      trialEndsAt,
      currentPeriodStart: now,
      currentPeriodEnd,
      usage: this.initializeUsage(plan),
      metadata: dto.metadata || {},
    });

    const saved = await this.subscriptionRepo.save(subscription);
    this.logger.log(`Subscription created: ${saved.id}`);

    return saved;
  }

  async getSubscription(id: string, tenantId: string): Promise<Subscription> {
    const subscription = await this.subscriptionRepo.findOne({
      where: { id, tenantId },
      relations: ['plan', 'invoices'],
    });

    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    return subscription;
  }

  // ==================== METERED BILLING ====================

  async recordUsage(
    tenantId: string,
    dto: RecordUsageDto,
  ): Promise<UsageRecord> {
    const subscription = await this.getSubscription(
      dto.subscriptionId,
      tenantId,
    );

    if (subscription.status !== SubscriptionStatus.ACTIVE) {
      throw new BadRequestException('Subscription is not active');
    }

    // Check if subscription has credit balance
    const creditBalance = await this.getCreditBalance(dto.subscriptionId);

    // Calculate price based on plan's metered pricing
    let unitPrice = 0;
    if (subscription.plan.meteredPricing?.enabled) {
      const metric = subscription.plan.meteredPricing.metrics.find(
        (m) => m.name === dto.usageType,
      );
      if (metric) {
        unitPrice = metric.pricePerUnit;
      }
    }

    const amount = dto.quantity * unitPrice;

    const usage = this.usageRepo.create({
      tenantId,
      subscriptionId: dto.subscriptionId,
      usageType: dto.usageType,
      quantity: dto.quantity,
      unitPrice,
      amount,
      description: dto.description,
      metadata: dto.metadata || {},
      timestamp: new Date(),
    });

    const saved = await this.usageRepo.save(usage);

    // Update subscription usage
    await this.updateSubscriptionUsage(
      dto.subscriptionId,
      dto.usageType,
      dto.quantity,
    );

    // If using credits, deduct from ledger
    if (creditBalance > 0 && amount > 0) {
      await this.deductCreditsForUsage(dto.subscriptionId, amount, saved.id);
    }

    this.logger.log(
      `Usage recorded: ${saved.id} - ${dto.usageType}: ${dto.quantity}`,
    );
    return saved;
  }

  // ==================== CREDIT LEDGER ====================

  async addCredits(
    tenantId: string,
    dto: AddCreditsDto,
  ): Promise<CreditLedger> {
    const subscription = await this.getSubscription(
      dto.subscriptionId,
      tenantId,
    );
    const currentBalance = await this.getCreditBalance(dto.subscriptionId);

    const transaction = this.creditRepo.create({
      tenantId,
      subscriptionId: dto.subscriptionId,
      transactionType: CreditTransactionType.PURCHASE,
      amount: dto.amount,
      balance: currentBalance + dto.amount,
      description: dto.description,
      metadata: dto.metadata || {},
      expiryDate: dto.expiryDate,
    });

    const saved = await this.creditRepo.save(transaction);
    this.logger.log(
      `Credits added: ${dto.amount} to subscription ${dto.subscriptionId}`,
    );

    return saved;
  }

  async getCreditBalance(subscriptionId: string): Promise<number> {
    const lastTransaction = await this.creditRepo.findOne({
      where: { subscriptionId },
      order: { createdAt: 'DESC' },
    });

    return lastTransaction?.balance || 0;
  }

  async deductCredits(
    subscriptionId: string,
    amount: number,
    description: string,
  ): Promise<CreditLedger> {
    const currentBalance = await this.getCreditBalance(subscriptionId);

    if (currentBalance < amount) {
      throw new BadRequestException('Insufficient credit balance');
    }

    const transaction = this.creditRepo.create({
      tenantId:
        (await this.subscriptionRepo.findOne({ where: { id: subscriptionId } }))
          ?.tenantId || '',
      subscriptionId,
      transactionType: CreditTransactionType.USAGE,
      amount: -amount,
      balance: currentBalance - amount,
      description,
    });

    return this.creditRepo.save(transaction);
  }

  // ==================== TAX ENGINE ====================

  calculateTax(
    subtotal: number,
    jurisdiction: string,
    taxConfig: any,
  ): { taxAmount: number; breakdown: any[] } {
    let taxAmount = 0;
    const breakdown: any[] = [];

    if (!taxConfig?.taxable) {
      return { taxAmount: 0, breakdown: [] };
    }

    // VAT/GST calculation based on jurisdiction
    if (taxConfig.vatRate) {
      const vatAmount = subtotal * (taxConfig.vatRate / 100);
      taxAmount += vatAmount;
      breakdown.push({
        type: 'VAT',
        rate: taxConfig.vatRate,
        amount: vatAmount,
      });
    }

    if (taxConfig.gstRate) {
      const gstAmount = subtotal * (taxConfig.gstRate / 100);
      taxAmount += gstAmount;
      breakdown.push({
        type: 'GST',
        rate: taxConfig.gstRate,
        amount: gstAmount,
      });
    }

    return { taxAmount, breakdown };
  }

  // ==================== INVOICING ====================

  async generateInvoice(
    subscriptionId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<Invoice> {
    const subscription = await this.subscriptionRepo.findOne({
      where: { id: subscriptionId },
      relations: ['plan'],
    });

    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Get un-invoiced usage records
      const usageRecords = await this.usageRepo.find({
        where: {
          subscriptionId,
          timestamp: Between(periodStart, periodEnd),
          invoiced: false,
        },
      });

      // Calculate totals
      const subtotal = subscription.plan.basePrice;
      let usageTotal = 0;

      // Create invoice
      const invoiceNumber = await this.generateInvoiceNumber(
        subscription.tenantId,
      );
      const invoice = queryRunner.manager.create(Invoice, {
        tenantId: subscription.tenantId,
        invoiceNumber,
        subscriptionId,
        periodStart,
        periodEnd,
        dueDate: new Date(periodEnd.getTime() + 7 * 24 * 60 * 60 * 1000), // 7 days
        status: InvoiceStatus.OPEN,
        subtotal,
        total: subtotal,
        amountDue: subtotal,
      });

      const savedInvoice = await queryRunner.manager.save(invoice);

      // Add base subscription item
      await queryRunner.manager.save(InvoiceItem, {
        invoiceId: savedInvoice.id,
        type: InvoiceItemType.SUBSCRIPTION,
        description: `${subscription.plan.name} - ${subscription.plan.interval}`,
        amount: subscription.plan.basePrice,
        quantity: 1,
        unitPrice: subscription.plan.basePrice,
      });

      // Add usage items
      for (const usage of usageRecords) {
        usageTotal += Number(usage.amount);

        await queryRunner.manager.save(InvoiceItem, {
          invoiceId: savedInvoice.id,
          type: InvoiceItemType.METERED,
          description: `${usage.usageType}: ${usage.quantity} units`,
          amount: usage.amount,
          quantity: usage.quantity,
          unitPrice: usage.unitPrice,
          metadata: {
            usageRecordId: usage.id,
            metricName: usage.usageType,
          },
        });

        // Mark usage as invoiced
        usage.invoiced = true;
        usage.invoiceId = savedInvoice.id;
        await queryRunner.manager.save(usage);
      }

      // Calculate tax
      const { taxAmount, breakdown } = this.calculateTax(
        subtotal + usageTotal,
        subscription.metadata?.billingAddress?.country || 'US',
        subscription.plan.taxConfig,
      );

      // Update invoice totals
      const total = subtotal + usageTotal + taxAmount;
      const creditBalance = await this.getCreditBalance(subscriptionId);
      const creditApplied = Math.min(creditBalance, total);
      const amountDue = total - creditApplied;

      savedInvoice.subtotal = subtotal + usageTotal;
      savedInvoice.taxAmount = taxAmount;
      savedInvoice.total = total;
      savedInvoice.creditApplied = creditApplied;
      savedInvoice.amountDue = amountDue;
      savedInvoice.taxDetails = {
        jurisdiction: subscription.metadata?.billingAddress?.country || 'US',
        taxRate:
          subscription.plan.taxConfig?.vatRate ||
          subscription.plan.taxConfig?.gstRate ||
          0,
        taxAmount,
        breakdown,
      };

      await queryRunner.manager.save(savedInvoice);

      // Deduct applied credits
      if (creditApplied > 0) {
        await this.deductCredits(
          subscriptionId,
          creditApplied,
          `Invoice ${invoiceNumber}`,
        );
      }

      await queryRunner.commitTransaction();
      this.logger.log(`Invoice generated: ${savedInvoice.invoiceNumber}`);

      return savedInvoice;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async processDailyBilling(): Promise<void> {
    this.logger.log('Processing daily billing cycle...');

    const now = new Date();

    // Find subscriptions ending their period today
    const subscriptions = await this.subscriptionRepo.find({
      where: {
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: Between(
          new Date(now.setHours(0, 0, 0, 0)),
          new Date(now.setHours(23, 59, 59, 999)),
        ),
      },
      relations: ['plan'],
    });

    for (const subscription of subscriptions) {
      try {
        // Generate invoice for the period
        await this.generateInvoice(
          subscription.id,
          subscription.currentPeriodStart,
          subscription.currentPeriodEnd,
        );

        // Advance to next period
        subscription.currentPeriodStart = subscription.currentPeriodEnd;
        subscription.currentPeriodEnd = this.calculatePeriodEnd(
          subscription.currentPeriodStart,
          subscription.plan.interval,
        );

        // Reset usage counters
        subscription.usage = this.initializeUsage(subscription.plan);

        await this.subscriptionRepo.save(subscription);
      } catch (error) {
        this.logger.error(
          `Failed to process billing for subscription ${subscription.id}:`,
          error,
        );
      }
    }
  }

  // ==================== PRIVATE HELPERS ====================

  private calculatePeriodEnd(start: Date, interval: PlanInterval): Date {
    const end = new Date(start);
    switch (interval) {
      case PlanInterval.MONTHLY:
        end.setMonth(end.getMonth() + 1);
        break;
      case PlanInterval.QUARTERLY:
        end.setMonth(end.getMonth() + 3);
        break;
      case PlanInterval.YEARLY:
        end.setFullYear(end.getFullYear() + 1);
        break;
    }
    return end;
  }

  private initializeUsage(plan: BillingPlan): Record<string, any> {
    const usage: Record<string, any> = {};

    if (plan.features?.limits) {
      for (const [key, limit] of Object.entries(plan.features.limits)) {
        usage[key] = {
          current: 0,
          limit,
          resetDate: new Date(),
        };
      }
    }

    return usage;
  }

  private async updateSubscriptionUsage(
    subscriptionId: string,
    usageType: string,
    quantity: number,
  ): Promise<void> {
    const subscription = await this.subscriptionRepo.findOne({
      where: { id: subscriptionId },
    });

    if (subscription && subscription.usage[usageType]) {
      subscription.usage[usageType].current += quantity;
      await this.subscriptionRepo.save(subscription);
    }
  }

  private async deductCreditsForUsage(
    subscriptionId: string,
    amount: number,
    usageRecordId: string,
  ): Promise<void> {
    await this.deductCredits(
      subscriptionId,
      amount,
      `Usage record: ${usageRecordId}`,
    );
  }

  private async generateInvoiceNumber(tenantId: string): Promise<string> {
    const count = await this.invoiceRepo.count({ where: { tenantId } });
    const date = new Date();
    return `INV-${tenantId.substring(0, 8)}-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}-${String(count + 1).padStart(6, '0')}`;
  }

  // ==================== ANALYTICS ====================

  async getBillingMetrics(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<any> {
    const invoices = await this.invoiceRepo.find({
      where: {
        tenantId,
        createdAt: Between(startDate, endDate),
        status: InvoiceStatus.PAID,
      },
    });

    const subscriptions = await this.subscriptionRepo.count({
      where: { tenantId, status: SubscriptionStatus.ACTIVE },
    });

    const totalRevenue = invoices.reduce(
      (sum, inv) => sum + Number(inv.total),
      0,
    );
    const averageInvoice =
      invoices.length > 0 ? totalRevenue / invoices.length : 0;

    return {
      totalRevenue,
      invoiceCount: invoices.length,
      averageInvoice,
      activeSubscriptions: subscriptions,
      mrr: await this.calculateMRR(tenantId),
    };
  }

  private async calculateMRR(tenantId: string): Promise<number> {
    const subscriptions = await this.subscriptionRepo.find({
      where: { tenantId, status: SubscriptionStatus.ACTIVE },
      relations: ['plan'],
    });

    return subscriptions.reduce((sum, sub) => {
      const price = Number(sub.plan.basePrice);
      switch (sub.plan.interval) {
        case PlanInterval.MONTHLY:
          return sum + price;
        case PlanInterval.QUARTERLY:
          return sum + price / 3;
        case PlanInterval.YEARLY:
          return sum + price / 12;
        default:
          return sum;
      }
    }, 0);
  }
}
