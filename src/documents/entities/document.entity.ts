import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Tenant } from '../../iam/entities/tenant.entity';
import { User } from '../../iam/entities/user.entity';
import { DocumentVersion } from './document-version.entity';

export enum DocumentStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  DELETED = 'deleted',
}

export enum DocumentEncryption {
  NONE = 'none',
  STANDARD = 'standard',
  HIGH = 'high',
}

export enum DocumentType {
  PDF = 'pdf',
  JPG = 'jpg',
  JPEG = 'jpeg',
  PNG = 'png',
  DOCX = 'docx',
  XLSX = 'xlsx',
  TXT = 'txt',
}

@Entity('documents')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'linkedEntityType', 'linkedEntityId'])
export class Document {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @ManyToOne(() => Tenant, { eager: false })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column()
  name: string;

  @Column({ unique: true })
  slug: string;

  @Column({ type: 'enum', enum: DocumentType })
  fileType: DocumentType;

  @Column()
  originalFileName: string;

  @Column()
  fileSize: number;

  @Column({ type: 'text', nullable: true })
  mimeType: string;

  @Column({ type: 'enum', enum: DocumentStatus, default: DocumentStatus.ACTIVE })
  status: DocumentStatus;

  @Column({ type: 'enum', enum: DocumentEncryption, default: DocumentEncryption.NONE })
  encryption: DocumentEncryption;

  @Column({ type: 'enum', enum: DocumentEncryption, default: DocumentEncryption.NONE })
  requiredEncryption: DocumentEncryption;

  @Column({ nullable: true })
  linkedEntityType: string;

  @Column({ nullable: true })
  linkedEntityId: string;

  @Column({ type: 'jsonb', default: [] })
  tags: string[];

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, any>;

  @Column({ type: 'jsonb', default: {} })
  aiAnalysis: {
    extractedData?: Record<string, any>;
    summary?: string;
    categories?: string[];
    riskLevel?: 'low' | 'medium' | 'high';
    analyzedAt?: Date;
  };

  @Column({ type: 'jsonb', default: {} })
  rbac: {
    owner: string;
    roles?: string[];
    permissions?: {
      read: string[];
      write: string[];
      delete: string[];
      share: string[];
    };
  };

  @Column({ type: 'int', default: 1 })
  versionNumber: number;

  @Column({ type: 'uuid', nullable: true })
  currentVersionId: string;

  @Column({ type: 'text', nullable: true })
  s3Url: string;

  @ManyToOne(() => User, { eager: false })
  @JoinColumn({ name: 'uploadedById' })
  uploadedBy: User;

  @Column({ name: 'uploadedById' })
  uploadedById: string;

  @OneToMany(() => DocumentVersion, (version) => version.document, { cascade: true })
  versions: DocumentVersion[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  deletedAt: Date;
}
