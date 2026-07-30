import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';

export enum AuthTokenType {
  PASSWORD_RESET = 'password_reset',
  INVITE = 'invite',
}

/**
 * Single-use, time-limited token for password reset and invite acceptance.
 *
 * Only the SHA-256 of the token is stored, never the token itself — the same
 * rule as `sessions.refreshTokenHash`. A leaked database dump must not hand the
 * attacker a working set-password link for every pending invite.
 *
 * `usedAt` rather than deletion on redemption: a consumed token that is later
 * replayed should be distinguishable from one that never existed when reading
 * the audit trail, and the row is small.
 */
@Entity('auth_tokens')
@Index(['tokenHash'], { unique: true })
@Index(['userId'])
@Index(['tenantId'])
export class AuthToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'enum', enum: AuthTokenType })
  type: AuthTokenType;

  @Column({ length: 128 })
  tokenHash: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  /** Set when redeemed. A token with this set is dead, permanently. */
  @Column({ type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  /** `users.id` of whoever issued an invite. Null for self-service resets. */
  @Column({ type: 'uuid', nullable: true })
  issuedBy: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
