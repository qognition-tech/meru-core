import {
  Body,
  Controller,
  INestApplication,
  Post,
  UploadedFile,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { UploadDocumentDto } from './dto/upload-document.dto';

/**
 * Guards a defect that reached production and survived a green suite.
 *
 * `POST /documents/upload` rejected *every* multipart upload with
 * `400 property file should not exist`. Nothing caught it: the unit tests
 * construct DocumentsService directly and never build a request, and the 785-
 * check contract sweep posts junk bodies and asserts a 400 — which an endpoint
 * that always 400s satisfies perfectly.
 *
 * So this test deliberately exercises the one thing neither of those does: a
 * real multipart request through a real global ValidationPipe configured
 * exactly as `src/main.ts` and `api/index.js` configure it. The controller here
 * is a stand-in so the assertion stays on the DTO/pipe contract and needs no
 * database.
 */
@Controller('documents')
class UploadProbeController {
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
  ) {
    return {
      received: !!file,
      size: file?.size,
      name: dto.name,
      tags: dto.tags,
      metadata: dto.metadata,
    };
  }
}

describe('UploadDocumentDto under the global ValidationPipe', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UploadProbeController],
    }).compile();

    app = moduleRef.createNestApplication();
    // Must mirror src/main.ts and api/index.js. If those change, change this.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('accepts a multipart upload instead of rejecting the file part', async () => {
    const res = await request(app.getHttpServer())
      .post('/documents/upload')
      .field('name', 'Passport — Amelia Hart')
      .attach('file', Buffer.from('%PDF-1.4 stub'), 'passport.pdf');

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      received: true,
      name: 'Passport — Amelia Hart',
    });
  });

  it('still rejects a genuinely unknown field', async () => {
    const res = await request(app.getHttpServer())
      .post('/documents/upload')
      .field('name', 'Passport — Amelia Hart')
      .field('notAField', 'x')
      .attach('file', Buffer.from('%PDF-1.4 stub'), 'passport.pdf');

    expect(res.status).toBe(400);
  });

  it('accepts a single tag, not only two or more', async () => {
    // multer yields a string for one `tags` part and an array only from two or
    // more, so without the DTO's @Transform this 400s while the identical call
    // with a second tag succeeds — which reads as flakiness, not as a bug.
    const res = await request(app.getHttpServer())
      .post('/documents/upload')
      .field('name', 'Police clearance')
      .field('tags', 'demo')
      .attach('file', Buffer.from('%PDF-1.4 stub'), 'pcc.pdf');

    expect(res.status).toBe(201);
  });

  it('parses metadata sent as a JSON string over multipart', async () => {
    const res = await request(app.getHttpServer())
      .post('/documents/upload')
      .field('name', 'Police clearance')
      .field('metadata', JSON.stringify({ specimen: true }))
      .attach('file', Buffer.from('%PDF-1.4 stub'), 'pcc.pdf');

    expect(res.status).toBe(201);
  });

  it('rejects malformed metadata rather than silently dropping it', async () => {
    // Passing the unparsable string through to @IsObject() is deliberate: an
    // upload that accepted the file and discarded the metadata would be worse
    // than one that failed.
    const res = await request(app.getHttpServer())
      .post('/documents/upload')
      .field('name', 'Police clearance')
      .field('metadata', '{not json')
      .attach('file', Buffer.from('%PDF-1.4 stub'), 'pcc.pdf');

    expect(res.status).toBe(400);
  });

  it('carries the optional pack-driven fields through', async () => {
    const res = await request(app.getHttpServer())
      .post('/documents/upload')
      .field('name', 'Bank statement — Feb 2026')
      .field('linkedEntityType', 'crm_entity')
      .field('linkedEntityId', '9c0eda8b-38ee-4860-b868-3da2e1221b77')
      .attach('file', Buffer.from('%PDF-1.4 stub'), 'statement.pdf');

    expect(res.status).toBe(201);
  });
});
