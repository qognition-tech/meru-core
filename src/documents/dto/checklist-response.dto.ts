import { ApiProperty } from '@nestjs/swagger';

/**
 * `GET /documents/checklist`. Two fields carry "we could not tell" as a value
 * distinct from "no", and a generated client must keep them:
 *
 * - `uploaded: null`  — no `entityId` was passed, so nothing was checked
 *                        ("not asked"), never "missing".
 * - `applies: null`   — the requirement is conditional and the record lacked
 *                        the field the condition reads ("may apply"), never a
 *                        firm requirement and never exempt.
 */
export class ChecklistDocumentDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ type: String, format: 'date-time' }) uploadedAt!: Date;
}

export class ChecklistExtractionDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: [String] }) fields!: string[];
}

export class ChecklistItemDto {
  @ApiProperty({ description: 'documentTypes[].key from the pack' })
  key!: string;

  @ApiProperty() label!: string;

  @ApiProperty() required!: boolean;

  @ApiProperty({ type: [String] }) acceptedFormats!: string[];

  @ApiProperty({ type: Number, nullable: true }) maxSizeMb!: number | null;

  @ApiProperty({ type: ChecklistExtractionDto, nullable: true })
  extraction!: ChecklistExtractionDto | null;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      'true/false when an entityId was supplied; null when it was not ("not asked" — do not render as missing)',
  })
  uploaded!: boolean | null;

  @ApiProperty({
    description: 'Whether the pack attaches an appliesWhen condition to this type',
  })
  conditional!: boolean;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      'true when unconditional or the condition held; false when it did not; null when conditional and unevaluable for this record ("may apply")',
  })
  applies!: boolean | null;

  @ApiProperty({ type: [ChecklistDocumentDto] })
  documents!: ChecklistDocumentDto[];
}

export class ChecklistResponseDto {
  @ApiProperty({ type: String, nullable: true }) vertical!: string | null;
  @ApiProperty() packCode!: string;
  @ApiProperty() packVersion!: string;
  @ApiProperty({ type: [ChecklistItemDto] }) items!: ChecklistItemDto[];

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Required items not yet uploaded. null when no entityId was supplied — unknown, not zero',
  })
  outstandingRequired!: number | null;
}
