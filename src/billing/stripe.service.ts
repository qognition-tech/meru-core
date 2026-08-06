import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Stripe from 'stripe';
import {
  Subscription,
  SubscriptionStatus,
} from './entities/subscription.entity';
import { Tenant, TenantPlan } from '../iam/entities/tenant.entity';
import { TenantContext } from '../core/tenancy/tenant-context';

/**
 * Stripe subscriptions (plans + seats). Degrades honestly: without
 * STRIPE_SECRET_KEY every entry point answers 503 "billing not configured"
 * rather than pretending. Test mode first — the key decides the mode.
 *
 * Money truth lives in Stripe; local rows (subscription/invoice/tenant.plan)
 * are a synced projection updated by webhooks, never authored locally.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private client: Stripe | null = null;

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepo: Repository<Subscription>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
  ) {}

  private stripe(): Stripe {
    if (!this.client) {
      const key = process.env.STRIPE_SECRET_KEY;
      if (!key) {
        throw new ServiceUnavailableException(
          'Billing is not configured (STRIPE_SECRET_KEY missing)',
        );
      }
      this.client = new Stripe(key);
    }
    return this.client;
  }

  get isConfigured(): boolean {
    return !!process.env.STRIPE_SECRET_KEY;
  }

  /** Checkout link for a plan; seats become the subscription quantity. */
  async createCheckoutSession(
    tenantId: string,
    input: { planCode: string; seats?: number; successUrl: string; cancelUrl: string },
  ): Promise<{ url: string }> {
    const stripe = this.stripe();

    // Plan→price mapping is env config (STRIPE_PRICE_STARTER, …), not the
    // billing_plans table — that table models per-tenant plan documents, not
    // the platform's Stripe catalogue.
    const priceId =
      process.env[`STRIPE_PRICE_${input.planCode.toUpperCase()}`];
    if (!priceId) {
      throw new BadRequestException(
        `Plan '${input.planCode}' has no Stripe price configured ` +
          `(set STRIPE_PRICE_${input.planCode.toUpperCase()})`,
      );
    }

    const customerId = await this.ensureCustomer(tenantId);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: input.seats ?? 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      subscription_data: { metadata: { tenantId, planCode: input.planCode } },
      metadata: { tenantId, planCode: input.planCode },
    });

    if (!session.url) throw new BadRequestException('Stripe returned no URL');
    return { url: session.url };
  }

  /** Stripe-hosted billing portal for invoices/payment methods/cancellation. */
  async createPortalSession(
    tenantId: string,
    returnUrl: string,
  ): Promise<{ url: string }> {
    const stripe = this.stripe();
    const customerId = await this.ensureCustomer(tenantId);
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  private async ensureCustomer(tenantId: string): Promise<string> {
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new BadRequestException('Tenant not found');

    const existing = (tenant.metadata as { stripeCustomerId?: string } | null)
      ?.stripeCustomerId;
    if (existing) return existing;

    const customer = await this.stripe().customers.create({
      name: tenant.name,
      metadata: { tenantId: tenant.id, slug: tenant.slug },
    });
    tenant.metadata = { ...(tenant.metadata ?? {}), stripeCustomerId: customer.id };
    await this.tenantRepo.save(tenant);
    return customer.id;
  }

  /** Verify + apply a webhook. Runs as system: Stripe has no tenant binding. */
  async handleWebhook(rawBody: Buffer, signature: string): Promise<{ received: true }> {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new ServiceUnavailableException(
        'Billing webhooks not configured (STRIPE_WEBHOOK_SECRET missing)',
      );
    }
    const event = this.stripe().webhooks.constructEvent(rawBody, signature, secret);

    await TenantContext.runAsSystem(`stripe webhook ${event.type}`, async () => {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          await this.applyPlan(
            session.metadata?.tenantId,
            session.metadata?.planCode,
            typeof session.subscription === 'string' ? session.subscription : null,
          );
          break;
        }
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          await this.syncSubscriptionStatus(
            sub.metadata?.tenantId,
            sub.id,
            sub.status,
          );
          break;
        }
        default:
          this.logger.debug(`Unhandled Stripe event: ${event.type}`);
      }
    });

    return { received: true };
  }

  private async applyPlan(
    tenantId: string | undefined | null,
    planCode: string | undefined | null,
    stripeSubscriptionId: string | null,
  ): Promise<void> {
    if (!tenantId || !planCode) {
      this.logger.warn('checkout.session.completed without tenant/plan metadata');
      return;
    }
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) return;

    if ((Object.values(TenantPlan) as string[]).includes(planCode)) {
      tenant.plan = planCode as TenantPlan;
    }
    tenant.metadata = {
      ...(tenant.metadata ?? {}),
      ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
    };
    await this.tenantRepo.save(tenant);
    this.logger.log(`Tenant ${tenantId} upgraded to '${planCode}' via Stripe`);
  }

  private async syncSubscriptionStatus(
    tenantId: string | undefined | null,
    stripeSubscriptionId: string,
    stripeStatus: string,
  ): Promise<void> {
    if (!tenantId) return;
    // Cancellation downgrades the tenant to free; other states record only.
    if (['canceled', 'unpaid', 'incomplete_expired'].includes(stripeStatus)) {
      const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
      if (tenant) {
        tenant.plan = TenantPlan.FREE;
        await this.tenantRepo.save(tenant);
        this.logger.log(
          `Tenant ${tenantId} downgraded to free (Stripe ${stripeStatus})`,
        );
      }
    }
    const local = await this.subscriptionRepo.findOne({
      where: { tenantId } as never,
      order: { createdAt: 'DESC' } as never,
    });
    if (local) {
      local.status =
        stripeStatus === 'active'
          ? SubscriptionStatus.ACTIVE
          : SubscriptionStatus.CANCELLED;
      await this.subscriptionRepo.save(local);
    }
  }
}
