import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Always required — never ship HTML-only mail. */
  text: string;
  html?: string;
}

/**
 * Outbound transactional email, via Resend.
 *
 * One mail path for the whole platform. It was previously AWS SES, and the
 * only SES client lived privately inside `TenantProvisioningService` — so
 * invites and password resets had nowhere to send from, and the welcome email
 * worked while everything else silently did not.
 *
 * When Resend is not configured the service does **not** pretend to send: it
 * logs the full message, including any action link, and reports
 * `delivered: false`. A no-op that returns success is what makes "the invite
 * never arrived" take a day to diagnose, and the logged link is what lets an
 * operator unblock a user before credentials are sorted out.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend | null;
  private readonly from: string;
  readonly appUrl: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = config.get<string>('RESEND_API_KEY');

    // Resend requires the sender to be on a domain verified in the account.
    // `onboarding@resend.dev` is Resend's own sandbox sender, which works
    // without domain verification but only delivers to the account owner —
    // fine for a first smoke test, useless in production, hence the warning.
    this.from =
      config.get<string>('RESEND_FROM') ?? 'Meru <onboarding@resend.dev>';
    this.appUrl = config.get<string>('APP_URL') ?? 'https://app.meru.com';

    if (apiKey) {
      this.resend = new Resend(apiKey);
      this.logger.log(`Mail enabled via Resend — from: ${this.from}`);

      if (this.from.includes('onboarding@resend.dev')) {
        this.logger.warn(
          'RESEND_FROM is unset, using Resend’s sandbox sender. It only ' +
            'delivers to the Resend account owner — set RESEND_FROM to an ' +
            'address on a verified domain before relying on this.',
        );
      }
    } else {
      this.resend = null;
      this.logger.warn(
        'Mail disabled — set RESEND_API_KEY to send. Messages will be logged ' +
          'in full (including action links) instead of delivered.',
      );
    }
  }

  isConfigured(): boolean {
    return this.resend !== null;
  }

  /**
   * Send a message. Never throws.
   *
   * Mail is a side effect of flows that must complete regardless — a user has
   * still been invited even if Resend is down, and a password-reset request must
   * not leak "this address exists" through a 500. Failures are logged and
   * reported in the return value.
   */
  async send(message: MailMessage): Promise<{ delivered: boolean }> {
    if (!this.resend) {
      this.logger.warn(
        `[mail-not-configured] to=${message.to} subject="${message.subject}"\n${message.text}`,
      );
      return { delivered: false };
    }

    try {
      const { data, error } = await this.resend.emails.send({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      });

      // Resend reports failures in the response body rather than by throwing.
      // Treating a populated `error` as success is exactly the 200-with-error
      // trap the government adapters had — the send would look fine and the
      // mail would never arrive.
      if (error) {
        this.logger.error(
          `Mail to ${message.to} rejected by Resend: ${error.name} — ${error.message}`,
        );
        // Log the body so an operator can still recover an action link.
        this.logger.warn(`[mail-undelivered] ${message.text}`);
        return { delivered: false };
      }

      this.logger.log(
        `Mail sent to ${message.to}: ${message.subject} (id: ${data?.id})`,
      );
      return { delivered: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Mail to ${message.to} failed: ${detail}`);
      this.logger.warn(`[mail-undelivered] ${message.text}`);
      return { delivered: false };
    }
  }

  /** Escape interpolated values for the HTML bodies below. */
  escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Shared chrome so every Meru email looks like it came from one product. */
  private layout(heading: string, bodyHtml: string): string {
    return `
      <html><body style="font-family:sans-serif;max-width:600px;margin:auto;color:#111">
        <h2>${this.escapeHtml(heading)}</h2>
        ${bodyHtml}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
        <p style="color:#6b7280;font-size:12px">Meru Regulatory OS &mdash; <a href="https://meru.com">meru.com</a></p>
      </body></html>
    `;
  }

  private actionButton(url: string, label: string): string {
    return `<p><a href="${url}" style="background:#0f172a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">${this.escapeHtml(label)}</a></p>`;
  }

  /**
   * Invitation to join a tenant.
   *
   * Carries a set-password link rather than a temporary password. The invite
   * used to return a generated plaintext password to whoever called the API,
   * which meant anyone who could invite could immediately authenticate as the
   * invitee. A single-use token the invitee alone receives closes that.
   */
  async sendInvite(params: {
    to: string;
    inviterName: string;
    tenantName: string;
    token: string;
    expiresAt: Date;
  }): Promise<{ delivered: boolean }> {
    const url = `${this.appUrl}/accept-invite?token=${params.token}`;
    const expiry = params.expiresAt.toUTCString();

    return this.send({
      to: params.to,
      subject: `${params.inviterName} invited you to ${params.tenantName} on Meru`,
      text: [
        `${params.inviterName} has invited you to join ${params.tenantName} on Meru.`,
        '',
        `Set your password to get started: ${url}`,
        '',
        `This link can be used once and expires on ${expiry}.`,
        'If you were not expecting this invitation you can ignore this email.',
        '',
        '— The Meru Team',
      ].join('\n'),
      html: this.layout(
        `You have been invited to ${params.tenantName}`,
        `<p><strong>${this.escapeHtml(params.inviterName)}</strong> has invited you to join
           <strong>${this.escapeHtml(params.tenantName)}</strong> on Meru.</p>
         ${this.actionButton(url, 'Set your password')}
         <p style="color:#6b7280;font-size:13px">This link can be used once and expires on ${expiry}.
            If you were not expecting this invitation you can ignore this email.</p>`,
      ),
    });
  }

  /** Welcome email for a freshly provisioned workspace. */
  async sendWelcome(params: {
    to: string;
    firstName?: string | null;
    tenantName: string;
    tenantSlug: string;
    plan: string;
    trialEndsAt?: Date | null;
  }): Promise<{ delivered: boolean }> {
    const loginUrl = `${this.appUrl}/login?tenant=${params.tenantSlug}`;
    const trial = params.trialEndsAt
      ? `Trial ends: ${params.trialEndsAt.toDateString()}`
      : '';

    return this.send({
      to: params.to,
      subject: `Welcome to Meru — your ${params.tenantName} workspace is ready`,
      text: [
        `Hi${params.firstName ? ` ${params.firstName}` : ''},`,
        '',
        `Your Meru workspace for ${params.tenantName} has been created.`,
        '',
        `Log in here: ${loginUrl}`,
        '',
        `Workspace: ${params.tenantSlug}`,
        `Plan: ${params.plan}`,
        trial,
        '',
        'If you have questions, reply to this email.',
        '',
        '— The Meru Team',
      ]
        .filter(Boolean)
        .join('\n'),
      html: this.layout(
        'Welcome to Meru',
        `<p>Your workspace for <strong>${this.escapeHtml(params.tenantName)}</strong> is ready.</p>
         ${this.actionButton(loginUrl, 'Log in to your workspace')}
         <p style="color:#6b7280;font-size:13px">
           Workspace: ${this.escapeHtml(params.tenantSlug)}<br>
           Plan: ${this.escapeHtml(params.plan)}${trial ? `<br>${trial}` : ''}
         </p>`,
      ),
    });
  }

  /** Password-reset link. Same single-use token machinery as the invite. */
  async sendPasswordReset(params: {
    to: string;
    firstName?: string | null;
    token: string;
    expiresAt: Date;
  }): Promise<{ delivered: boolean }> {
    const url = `${this.appUrl}/reset-password?token=${params.token}`;
    const expiry = params.expiresAt.toUTCString();

    return this.send({
      to: params.to,
      subject: 'Reset your Meru password',
      text: [
        `Hi${params.firstName ? ` ${params.firstName}` : ''},`,
        '',
        'We received a request to reset your Meru password.',
        '',
        `Reset it here: ${url}`,
        '',
        `This link can be used once and expires on ${expiry}.`,
        'If you did not request this, you can ignore this email — your password will not change.',
        '',
        '— The Meru Team',
      ].join('\n'),
      html: this.layout(
        'Reset your password',
        `<p>We received a request to reset your Meru password.</p>
         ${this.actionButton(url, 'Reset password')}
         <p style="color:#6b7280;font-size:13px">This link can be used once and expires on ${expiry}.
            If you did not request this, ignore this email — your password will not change.</p>`,
      ),
    });
  }
}
