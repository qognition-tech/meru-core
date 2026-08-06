import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

export interface CipherEnvelope {
  iv: string;
  tag: string;
  data: string;
}

/**
 * AES-256-GCM envelope for tenant connector credentials.
 *
 * Key comes from CREDENTIALS_ENCRYPTION_KEY (any string ≥ 32 chars; hashed to
 * 32 bytes). No key ⇒ throws rather than storing plaintext or a weak default:
 * sandbox connectors need no credentials, and live credentials without a real
 * key configured is exactly the misconfiguration to fail loudly on. KMS
 * replaces this when per-tenant keys land (CLAUDE.md §6.4 storage note).
 */
function key(): Buffer {
  const secret = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error(
      'CREDENTIALS_ENCRYPTION_KEY (≥32 chars) must be set to store connector credentials',
    );
  }
  return createHash('sha256').update(secret).digest();
}

export function encryptCredentials(
  plain: Record<string, unknown>,
): CipherEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(plain), 'utf8'),
    cipher.final(),
  ]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decryptCredentials(
  envelope: CipherEnvelope,
): Record<string, unknown> {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(),
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8'));
}
