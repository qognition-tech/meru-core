import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { ThreadService } from './thread.service';
import { NotificationType } from './entities/notification.entity';
import { SendThreadMessageDto } from './dto/notification.dto';
import type { AuthenticatedRequest } from '../common/types';

/**
 * The conversation view of COM.
 *
 * Separate from `/notifications`, which is the delivery log and stays exactly
 * what it is — a per-recipient list of things the platform sent. This is the
 * inbox: grouped by counterparty, readable in order, and writable, because an
 * inbox that cannot send is one staff will abandon for their own mail client,
 * taking the firm's record of the conversation with them.
 */
@Controller('communications')
@ApiTags('communications')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
export class CommunicationsController {
  constructor(private readonly threads: ThreadService) {}

  /**
   * The caller's own address when they are a client rather than staff, else
   * null for the firm-wide view.
   *
   * Threads are keyed on the counterparty's address, so a client's confinement
   * is their email — not their user id as in CRM and payments, because no
   * platform user id appears in a thread key. Same shape of check as
   * `PaymentsController.clientScope`, third resource to need it.
   */
  private clientScope(req: AuthenticatedRequest): string | null {
    const roles = req.user.roles ?? [];
    const isStaff = roles.some((r) =>
      [
        PlatformRole.PLATFORM_ADMIN,
        PlatformRole.FIRM_ADMIN,
        PlatformRole.STAFF,
      ].includes(r as PlatformRole),
    );
    return roles.includes(PlatformRole.CLIENT) && !isStaff
      ? req.user.email
      : null;
  }

  @Get('threads')
  @ApiOperation({
    summary: 'List conversations, most recently active first',
    description:
      'One row per (counterparty, channel). `unreadCount` counts inbound ' +
      'messages only — an outbound message is not something anyone has to read. ' +
      '\n\n**A `client`-role caller sees only their own thread**, matched on ' +
      'their account email. Staff see the whole firm. A client cannot widen it.',
  })
  @ApiQuery({ name: 'channel', required: false, enum: NotificationType })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listThreads(
    @Request() req: AuthenticatedRequest,
    @Query('channel') channel?: NotificationType,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.threads.listThreads(req.user.tenantId, {
      channel,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      counterparty: this.clientScope(req),
    });
  }

  @Get('threads/:threadKey')
  @ApiOperation({
    summary: 'One conversation, oldest message first',
    description:
      'A `client`-role caller may read only the thread whose counterparty is ' +
      'their own address. Any other key returns **404, not 403** — the key ' +
      'contains the counterparty, so confirming existence would leak who else ' +
      'the firm corresponds with.',
  })
  @ApiResponse({ status: 404, description: 'No such thread, or not the caller\'s' })
  @ApiParam({
    name: 'threadKey',
    description: 'Thread key, e.g. `email:jane@example.com`',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getThread(
    @Request() req: AuthenticatedRequest,
    @Param('threadKey') threadKey: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.threads.getThread(req.user.tenantId, threadKey, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      counterparty: this.clientScope(req),
    });
  }

  @Post('threads/:threadKey/messages')
  @ApiOperation({
    summary: 'Reply into an existing conversation',
    description:
      'Queued through the same dispatcher as every other message, so it ' +
      'retries and reports identically. With no mail transport configured the ' +
      'row is recorded as pending rather than lost — the send is on the record ' +
      'either way.',
  })
  @ApiParam({ name: 'threadKey', description: 'Thread key to reply into' })
  @ApiResponse({
    status: 400,
    description: 'threadKey disagrees with the channel and recipient given',
  })
  async reply(
    @Request() req: AuthenticatedRequest,
    @Param('threadKey') threadKey: string,
    @Body() dto: SendThreadMessageDto,
  ) {
    return this.threads.send({
      tenantId: req.user.tenantId,
      senderId: req.user.id,
      channel: dto.channel,
      to: dto.to,
      subject: dto.subject,
      content: dto.content,
      threadKey,
      metadata: dto.metadata,
      asCounterparty: this.clientScope(req),
    });
  }

  @Post('messages')
  @ApiOperation({
    summary: 'Start a conversation',
    description:
      'The thread key is derived from channel and recipient, so sending to ' +
      'the same person twice continues one thread rather than opening two.',
  })
  async send(
    @Request() req: AuthenticatedRequest,
    @Body() dto: SendThreadMessageDto,
  ) {
    return this.threads.send({
      tenantId: req.user.tenantId,
      senderId: req.user.id,
      channel: dto.channel,
      to: dto.to,
      subject: dto.subject,
      content: dto.content,
      metadata: dto.metadata,
      asCounterparty: this.clientScope(req),
    });
  }

  @Post('threads/:threadKey/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark every inbound message in a thread as read' })
  @ApiParam({ name: 'threadKey', description: 'Thread key' })
  async markRead(
    @Request() req: AuthenticatedRequest,
    @Param('threadKey') threadKey: string,
  ) {
    return this.threads.markRead(
      req.user.tenantId,
      threadKey,
      this.clientScope(req),
    );
  }
}
