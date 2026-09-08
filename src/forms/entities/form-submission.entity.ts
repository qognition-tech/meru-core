import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { FormSchema } from './form-schema.entity';

export enum SubmissionStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  UNDER_REVIEW = 'under_review',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  COMPLETED = 'completed',
}

@Entity('form_submissions')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'entityId'])
@Index(['formSchemaId', 'status'])
export class FormSubmission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column()
  formSchemaId: string;

  @ManyToOne(() => FormSchema)
  @JoinColumn({ name: 'formSchemaId' })
  formSchema: FormSchema;

  @Column({ nullable: true })
  entityId: string; // ID of the entity this submission is for (if editing existing)

  @Column({
    type: 'enum',
    enum: SubmissionStatus,
    default: SubmissionStatus.DRAFT,
  })
  status: SubmissionStatus;

  @Column({ type: 'jsonb' })
  data: Record<string, any>;

  @Column({ type: 'jsonb', default: [] })
  history: Array<{
    timestamp: Date;
    action: string;
    userId: string;
    changes: Record<string, any>;
  }>;

  @Column({ type: 'jsonb', default: [] })
  validationErrors: Array<{
    field: string;
    message: string;
    type: string;
  }>;

  @Column({ type: 'jsonb', default: {} })
  metadata: {
    ipAddress?: string;
    userAgent?: string;
    source?: string;
    referrer?: string;
    documentAnalysis?: any[];
  };

  @Column()
  submittedBy: string;

  @Column({ type: 'timestamp', nullable: true })
  submittedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  reviewedBy: string | null;

  @Column({ type: 'timestamp', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  reviewNotes: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
