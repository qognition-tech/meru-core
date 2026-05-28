import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateDocumentDto } from './create-document.dto';
import {
  DocumentStatus,
  DocumentEncryption,
} from '../entities/document.entity';

export class UpdateDocumentDto extends PartialType(
  OmitType(CreateDocumentDto, [
    'fileType',
    'originalFileName',
    'fileSize',
  ] as const),
) {
  name?: string;
  status?: DocumentStatus;
  encryption?: DocumentEncryption;
  requiredEncryption?: DocumentEncryption;
  linkedEntityType?: string;
  linkedEntityId?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}
