import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('config_packs')
@Index(['code'])
@Index(['vertical'])
export class ConfigPack {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  code: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column()
  version: string;

  @Column({ nullable: true })
  vertical: string;

  @Column({ type: 'jsonb', default: {} })
  schema: Record<string, any>;

  @Column({ type: 'jsonb', default: {} })
  defaults: Record<string, any>;

  @Column({ type: 'jsonb', default: {} })
  uiConfig: Record<string, any>;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
