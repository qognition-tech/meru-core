import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as AWS from 'aws-sdk';

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Always required — never ship HTML-only mail. */
  text: string;
  html?: string;
}

/**
 * Outbound transactional email.
 *
 * Extracted from `TenantProvisioningService`, which owned the only SES client
 * in the codebase and kept it private. Invites and password resets need to send
 * too, and three copies of an SES client with three slightly different
 * from-addresses is how a product ends up with mail that works in one flow and
 * silently drops in another.
 *
 * When SES is not configured the service does **not** pretend to send: it logs
 * the full message at warn level and reports `delivered: false` to the caller.
 * A no-op that returns success is what makes "the invite email never arrived"
 * take a day to diagnose.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly ses: AWS.SES | null;
  private readonly from: string;
  readonly appUrl: string;

  constructor(private readonly config: ConfigService) {
    const sesEnabled =
      config.get<string>('SES_ENABLED') !== 'false' &&
      !!config.get<string>('AWS_REGION');

    this.from = config.get<string>('SES_FROM_ADDRESS') ?? 'hello@meru.com';
    this.appUrl = config.get<string>('APP_URL') ?? 'https://app.meru.com';

    if (sesEnabled) {
      this.ses = new AWS.SES({
        region: config.get<string>('AWS_REGION') ?? 'us-east-1',
      });
      this.logger.log(`Mail enabled via SES — from: ${this.from}`);
    } else {
      this.ses = null;
      this.logger.warn(
        'Mail disabled — set AWS_REGION (and SES_ENABLED != false) to send. ' +
          'Messages will be logged instead of delivered.',
      );
    }
  }

  isConfigured(): boolean {
    return this.ses !== null;
  }

  /**
   * Send a message. Never throws.
   *
   * Mail is a side effect of flows that must complete regardless — a user has
   * still been invited even if SES is down, and a password-reset request must
   * not leak "this address exists" through a 500. Failures are logged and
   * reported in the return value.
   */
  async send(message: MailMessage): Promise<{ delivered: boolean }> {
    if (!this.ses) {
      this.logger.warn(
        `[mail-not-configured] to=${message.to} subject="${message.subject}"\n${message.text}`,
      );
      return { delivered: false };
    }

    try {
      await this.ses
        .sendEmail({
          Source: this.from,
          Destination: { ToAddresses: [message.to] },
          Message: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: message.text, Charset: 'UTF-8' },
              ...(message.html
                ? { Html: { Data: message.html, Charset: 'UTF-8' } }
                : {}),
            },
          },
        })
        .promise();

      this.logger.log(`Mail sent to ${message.to}: ${message.subject}`);
      return { delivered: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Mail to ${message.to} failed: ${detail}`);
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
