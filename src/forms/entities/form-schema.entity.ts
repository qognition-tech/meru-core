import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { FormField } from './form-field.entity';

export enum FormStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  DEPRECATED = 'deprecated',
}

export enum FormLayout {
  SINGLE_COLUMN = 'single_column',
  TWO_COLUMN = 'two_column',
  WIZARD = 'wizard',
  TABS = 'tabs',
}

@Entity('form_schemas')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'entityType'])
export class FormSchema {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column()
  entityType: string; // e.g., 'client', 'document', 'task'

  @Column({ type: 'enum', enum: FormStatus, default: FormStatus.DRAFT })
  status: FormStatus;

  @Column({ type: 'enum', enum: FormLayout, default: FormLayout.SINGLE_COLUMN })
  layout: FormLayout;

  @Column({ type: 'int', default: 1 })
  version: number;

  @OneToMany(() => FormField, (field) => field.formSchema, { cascade: true })
  fields: FormField[];

  @Column({ type: 'jsonb', default: {} })
  config: {
    submitButton?: {
      label: string;
      action: string;
    };
    cancelButton?: {
      label: string;
      action: string;
    };
    multiStep?: {
      enabled: boolean;
      steps: Array<{
        title: string;
        description?: string;
        fieldIds: string[];
      }>;
    };
    conditionalLogic?: Array<{
      condition: {
        field: string;
        operator: string;
        value: any;
      };
      actions: Array<{
        type: 'show' | 'hide' | 'enable' | 'disable' | 'set_value';
        target: string;
        value?: any;
      }>;
    }>;
  };

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  deletedAt: Date;
}
