import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { SendDirectMessageDto } from './dto/send-direct-message.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

/**
 * Type defining the requesting user (actor) details.
 */
type Actor = { userId: string };

/**
 * REST Controller exposing HTTP endpoints for direct messaging,
 * conversation listing, unread message counting, and conversation history retrieval.
 */
@ApiTags('Messages')
@ApiBearerAuth('access-token')
@Controller('messages')
export class MessagesController {
    constructor(private readonly messagesService: MessagesService) {}

    /**
     * Lists all active conversations (Direct messages & Platform channels) accessible to the requesting user.
     * Includes unread counts and latest message snippets.
     * @route GET /messages/conversations
     */
    @Get('conversations')
    listConversations(@CurrentUser() actor: Actor) {
        return this.messagesService.listConversations(actor);
    }

    /**
     * Retrieves the total count of unread messages across all user conversations.
     * @route GET /messages/unread-count
     */
    @Get('unread-count')
    getUnreadCount(@CurrentUser() actor: Actor) {
        return this.messagesService.getUnreadCount(actor);
    }

    /**
     * Retrieves paginated message history for a specific conversation by ID.
     * Automatically updates the user's read status timestamp (`lastReadAt`).
     * @route GET /messages/conversations/:id
     */
    @Get('conversations/:id')
    getMessages(@CurrentUser() actor: Actor, @Param('id') id: string, @Query('limit') limit?: string) {
        return this.messagesService.getMessages(actor, id, limit ? Number(limit) : undefined);
    }

    /**
     * Dispatches a message to an existing conversation (Direct or Channel) by ID.
     * @route POST /messages/conversations/:id
     */
    @Post('conversations/:id')
    sendToConversation(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: SendMessageDto) {
        return this.messagesService.sendToConversation(actor, id, dto.content);
    }

    /**
     * Initiates or continues a 1-on-1 direct conversation with a targeted user.
     * @route POST /messages/direct/:userId
     */
    @Post('direct/:userId')
    sendDirectMessage(
        @CurrentUser() actor: Actor,
        @Param('userId') userId: string,
        @Body() dto: SendDirectMessageDto,
    ) {
        return this.messagesService.sendDirectMessage(actor, userId, dto.content);
    }
}