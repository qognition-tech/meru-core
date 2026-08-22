import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { Document } from './document.entity';
import { User } from '../../iam/entities/user.entity';

export enum VersionStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

@Entity('document_versions')
@Index(['documentId', 'versionNumber'])
export class DocumentVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  documentId: string;

  @ManyToOne(() => Document, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'documentId' })
  document: Document;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column({ type: 'int' })
  versionNumber: number;

  @Column({ type: 'enum', enum: VersionStatus, default: VersionStatus.ACTIVE })
  status: VersionStatus;

  @Column()
  s3Key: string;

  @Column({ type: 'text' })
  s3Bucket: string;

  /**
   * Which object store holds this version (`s3` | `supabase`). Null on rows
   * written before the column existed, which `StorageDriverRegistry.forFile`
   * resolves to the platform default — the only store that existed then.
   * The `s3Key`/`s3Bucket` names are historical; they are the object key and
   * bucket on whichever provider this names.
   */
  @Column({ type: 'text', nullable: true })
  storageProvider: string | null;

  @Column()
  fileSize: number;

  @Column({ type: 'text', nullable: true })
  checksum: string;

  @Column({ type: 'text', nullable: true })
  encryptionKey: string;

  @Column({ type: 'text', nullable: true })
  encryptionAlgorithm: string;

  @Column({ type: 'text', nullable: true })
  changeDescription: string;

  @Column({ type: 'jsonb', default: {} })
  changeMetadata: {
    changedBy: string;
    changeReason?: string;
    fieldsChanged?: string[];
  };

  @ManyToOne(() => User, { eager: false })
  @JoinColumn({ name: 'uploadedById' })
  uploadedBy: User;

  @Column({ name: 'uploadedById' })
  uploadedById: string;

  @CreateDateColumn()
  createdAt: Date;
}
