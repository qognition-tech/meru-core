import { PartialType } from '@nestjs/swagger';
import { CreateFormDto } from './create-form.dto';

/**
 * PUT /forms/:id body — every CreateFormDto field, all optional. Only valid
 * against DRAFT forms; published forms 409 and point at POST /forms/:id/version.
 */
export class UpdateFormDto extends PartialType(CreateFormDto) {}
