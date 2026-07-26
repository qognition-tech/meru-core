import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import {
  StorageProvider,
  StorageClass,
  FileStatus,
  FileAccess,
} from '../interfaces/storage.interface';

@Entity('storage_files')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'tags'])
@Index(['tenantId', 'folder'])
@Index(['key'])
export class StorageFile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({
    type: 'enum',
    enum: StorageProvider,
  })
  provider: StorageProvider;

  @Column()
  bucket: string;

  @Column()
  key: string;

  @Column()
  originalName: string;

  @Column()
  mimeType: string;

  @Column({ type: 'bigint' })
  size: number;

  @Column()
  checksum: string;

  @Column({
    type: 'enum',
    enum: FileStatus,
    default: FileStatus.ACTIVE,
  })
  status: FileStatus;

  @Column({
    type: 'enum',
    enum: StorageClass,
    default: StorageClass.STANDARD,
  })
  storageClass: StorageClass;

  @Column({
    type: 'enum',
    enum: FileAccess,
    default: FileAccess.PRIVATE,
  })
  access: FileAccess;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, any>;

  @Column({ type: 'simple-array', default: '' })
  tags: string[];

  @Column({ type: 'jsonb', nullable: true })
  encryption: {
    algorithm: string;
    keyId?: string;
  } | null;

  @Column({ type: 'uuid' })
  currentVersionId: string;

  @Column({ type: 'uuid' })
  createdById: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @DeleteDateColumn()
  deletedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastAccessedAt: Date | null;

  @Column({ type: 'int', default: 0 })
  accessCount: number;

  @Column({ type: 'varchar', nullable: true })
  folder: string | null;

  @OneToMany(() => FileVersion, (version) => version.file, { cascade: true })
  versions: FileVersion[];
}

@Entity('storage_file_versions')
@Index(['fileId'])
export class FileVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  fileId: string;

  @Column({ type: 'int' })
  versionNumber: number;

  @Column({ type: 'bigint' })
  size: number;

  @Column()
  checksum: string;

  @Column()
  key: string;

  @Column({ type: 'uuid' })
  createdById: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'text', nullable: true })
  changeDescription: string | null;

  @Column({ type: 'boolean', default: false })
  isCurrent: boolean;

  @ManyToOne(() => StorageFile, (file) => file.versions)
  @JoinColumn({ name: 'fileId' })
  file: StorageFile;
}

@Entity('storage_multipart_uploads')
@Index(['fileId'])
@Index(['status'])
export class MultipartUpload {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  uploadId: string;

  @Column({ type: 'uuid' })
  fileId: string;

  @Column({ type: 'simple-json' })
  parts: {
    partNumber: number;
    etag?: string;
    size: number;
    status: 'pending' | 'uploaded';
  }[];

  @Column({ type: 'bigint' })
  partSize: number;

  @Column({ type: 'int' })
  totalParts: number;

  @Column({ type: 'int', default: 0 })
  completedParts: number;

  @Column({
    type: 'enum',
    enum: ['pending', 'in_progress', 'completed', 'aborted'],
    default: 'pending',
  })
  status: 'pending' | 'in_progress' | 'completed' | 'aborted';

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;
}
