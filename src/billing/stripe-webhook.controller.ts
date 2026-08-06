import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../iam/decorators/public.decorator';
import { StripeService } from './stripe.service';

/**
 * Deliberately its own controller: BillingController carries class-level
 * `AuthGuard('jwt')`, and Nest composes class+method guards — `@Public()`
 * only bypasses the global guard, so a webhook route inside that class would
 * 401 every Stripe delivery. Authentication here is the webhook signature,
 * verified inside StripeService with STRIPE_WEBHOOK_SECRET over the raw
 * bytes (rawBody enabled in main.ts).
 */
@Controller('billing')
@ApiTags('billing')
export class StripeWebhookController {
  constructor(private readonly stripeService: StripeService) {}

  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stripe webhook (signature-verified machine endpoint)' })
  @ApiResponse({ status: 200, description: 'Event processed' })
  @ApiResponse({ status: 400, description: 'Missing/invalid signature' })
  @ApiResponse({ status: 503, description: 'Stripe not configured' })
  async webhook(
    @Req() req: RawBodyRequest<ExpressRequest>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!req.rawBody || !signature) {
      throw new BadRequestException('Missing body or stripe-signature header');
    }
    return this.stripeService.handleWebhook(req.rawBody, signature);
  }
}
