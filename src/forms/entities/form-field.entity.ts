import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { FormSchema } from './form-schema.entity';

export enum FieldType {
  TEXT = 'text',
  TEXTAREA = 'textarea',
  NUMBER = 'number',
  EMAIL = 'email',
  PHONE = 'phone',
  DATE = 'date',
  DATETIME = 'datetime',
  SELECT = 'select',
  MULTI_SELECT = 'multi_select',
  RADIO = 'radio',
  CHECKBOX = 'checkbox',
  TOGGLE = 'toggle',
  FILE = 'file',
  SIGNATURE = 'signature',
  RICH_TEXT = 'rich_text',
  CURRENCY = 'currency',
  PERCENTAGE = 'percentage',
  ADDRESS = 'address',
  USER = 'user',
  ENTITY = 'entity',
}

@Entity('form_fields')
@Index(['formSchemaId', 'key'])
export class FormField {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  formSchemaId: string;

  @ManyToOne(() => FormSchema, (schema) => schema.fields, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'formSchemaId' })
  formSchema: FormSchema;

  @Column()
  key: string; // Unique identifier for the field

  @Column()
  label: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'text', nullable: true })
  placeholder: string;

  @Column({ type: 'enum', enum: FieldType })
  type: FieldType;

  @Column({ type: 'int', default: 0 })
  order: number;

  @Column({ type: 'jsonb', default: {} })
  validation: {
    required?: boolean;
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    pattern?: string;
    patternMessage?: string;
    customValidation?: string;
    unique?: boolean;
  };

  @Column({ type: 'jsonb', default: {} })
  options: {
    // For select, radio, checkbox types
    choices?: Array<{
      value: string;
      label: string;
      disabled?: boolean;
    }>;
    // Data source for dynamic options
    dataSource?: {
      type: 'api' | 'entity' | 'workflow';
      endpoint?: string;
      entityType?: string;
      filter?: Record<string, any>;
    };
  };

  @Column({ type: 'jsonb', default: {} })
  config: {
    defaultValue?: any;
    helpText?: string;
    tooltip?: string;
    width?: 'full' | 'half' | 'third';
    prefix?: string;
    suffix?: string;
    multiple?: boolean; // For file uploads
    maxFileSize?: number;
    allowedFileTypes?: string[];
    rows?: number; // For textarea
    step?: number; // For number inputs
    decimals?: number; // For currency
    currency?: string; // For currency
    searchable?: boolean; // For select fields
    creatable?: boolean; // Allow creating new options
    clearable?: boolean;
    disabled?: boolean;
    readOnly?: boolean;
    hidden?: boolean;
    mappedTo?: string; // Maps to entity field
  };

  @Column({ type: 'jsonb', default: {} })
  conditionalLogic?: {
    showIf?: {
      field: string;
      operator: string;
      value: any;
    };
    enabledIf?: {
      field: string;
      operator: string;
      value: any;
    };
  };
}
