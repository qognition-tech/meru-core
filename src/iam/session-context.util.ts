import type { Request } from 'express';
import type { SessionContext } from './iam.service';

/** Products allowed to identify themselves. Anything else is ignored. */
const KNOWN_CLIENTS = new Set([
  'immistack',
  'meru-dashboard',
  'governancex',
  'meru-admin',
]);

/**
 * Map a request Origin to the product that sent it.
 *
 * Only used as a fallback when the client does not announce itself with
 * `X-Client-Id`. Matching on substring rather than an exact host so Vercel
 * preview deployments (`governancex-<hash>-<team>.vercel.app`) still resolve
 * to the right product.
 */
function clientFromOrigin(origin?: string): string | undefined {
  if (!origin) return undefined;
  const host = origin.toLowerCase();

  if (host.includes('immistack')) return 'immistack';
  if (host.includes('governancex') || host.includes('governance'))
    return 'governancex';
  if (host.includes('meru-dashboard') || host.includes('app.meru'))
    return 'meru-dashboard';

  return undefined;
}

/**
 * Describe where a sign-in came from, for the session record.
 *
 * None of this is trusted for authorisation — it is descriptive metadata shown
 * back to the user so they can recognise and revoke their own sessions. A
 * client that lies about `X-Client-Id` only mislabels its own row, so the
 * value is bounded to a known set and truncated rather than validated harder.
 */
export function sessionContextFrom(req: Request): SessionContext {
  const declared = String(req.headers['x-client-id'] ?? '')
    .toLowerCase()
    .trim();

  const client = KNOWN_CLIENTS.has(declared)
    ? declared
    : clientFromOrigin(
        (req.headers.origin as string) ?? (req.headers.referer as string),
      );

  // `req.ip` honours trust proxy; on Vercel the real client address arrives in
  // x-forwarded-for, whose first entry is the originating client.
  const forwarded = (req.headers['x-forwarded-for'] as string) ?? '';
  const ipAddress =
    forwarded.split(',')[0].trim() || req.ip || req.socket?.remoteAddress || '';

  return {
    ipAddress: ipAddress.slice(0, 45),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 512),
    client,
  };
}
