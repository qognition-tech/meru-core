import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Latest known AIS state for a vessel.
 *
 * **Platform-global, not tenant-scoped.** A ship's position is a public fact
 * broadcast over VHF, not one tenant's data — two banks watching the same
 * tanker should see the same position, and storing it per tenant would mean N
 * copies drifting out of sync. Handled like `config_packs`: readable by every
 * tenant, writable only under bypass (the ingest endpoint), so one tenant
 * cannot poison another's view.
 *
 * One row per MMSI, updated in place. History belongs in a time-series store
 * if it is ever needed; keeping every position report here would grow without
 * bound for no current consumer.
 */
@Entity('vessel_positions')
@Index(['mmsi'], { unique: true })
@Index(['imo'])
@Index(['lastSeenAt'])
export class VesselPosition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Maritime Mobile Service Identity — 9 digits, the AIS primary key. */
  @Column({ length: 16 })
  mmsi: string;

  /** IMO number, when a type-5 static report has supplied one. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  imo: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  name: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  callSign: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  shipType: string | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  flag: string | null;

  // Nullable because a static (type 5) report carries identity but no fix,
  // while a position (type 1/2/3/18) report carries a fix but little identity.
  // Both update the same row, each filling in what it knows.
  @Column({ type: 'double precision', nullable: true })
  lat: number | null;

  @Column({ type: 'double precision', nullable: true })
  lon: number | null;

  /** Speed over ground, knots. */
  @Column({ type: 'double precision', nullable: true })
  sog: number | null;

  /** Course over ground, degrees. */
  @Column({ type: 'double precision', nullable: true })
  cog: number | null;

  @Column({ type: 'double precision', nullable: true })
  heading: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  navStatus: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  destination: string | null;

  /** When this vessel was last heard from — drives dark-period detection. */
  @Column({ type: 'timestamptz' })
  lastSeenAt: Date;

  /** Where the report came from: `nmea`, `json`, or a provider name. */
  @Column({ type: 'varchar', length: 32, default: 'nmea' })
  source: string;

  @UpdateDateColumn()
  updatedAt: Date;
}
