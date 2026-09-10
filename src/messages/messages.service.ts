import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';

/**
 * Type defining the requesting user (actor) context.
 */
type Actor = { userId: string };

/**
 * Domain Service handling direct messages, platform channels, unread message counters,
 * read state management, and automated email notifications for inactive users.
 */
@Injectable()
export class MessagesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
        private readonly emailService: EmailService,
    ) {}

    // ---- Direct Conversations ----

    /**
     * Sends a direct 1-on-1 message to another active user.
     * Finds or creates the target direct conversation before dispatching message and notifications.
     */
    async sendDirectMessage(actor: Actor, recipientId: string, content: string, replyToId?: string) {
        if (actor.userId === recipientId) {
            throw new ForbiddenException("You can't message yourself.");
        }
        const recipient = await this.prisma.user.findUnique({ where: { id: recipientId } });
        if (!recipient || recipient.status !== 'ACTIVE') {
            throw new NotFoundException('User not found.');
        }

        const conversation = await this.getOrCreateDirectConversation(actor.userId, recipientId);
        return this.createMessageAndNotify(conversation.id, actor.userId, content, [recipientId], replyToId);
    }

    /**
     * Helper retrieving an existing direct conversation between two users or initializing a new one.
     */
    private async getOrCreateDirectConversation(userAId: string, userBId: string) {
        const existing = await this.prisma.conversation.findFirst({
            where: {
                type: 'DIRECT',
                AND: [
                    { participants: { some: { userId: userAId } } },
                    { participants: { some: { userId: userBId } } },
                ],
            },
        });
        if (existing) return existing;

        return this.prisma.conversation.create({
            data: {
                type: 'DIRECT',
                participants: { create: [{ userId: userAId }, { userId: userBId }] },
            },
        });
    }

    // ---- Platform Channels ----

    /**
     * Fetches or creates the dedicated channel conversation associated with a platform.
     * Verifies platform membership or ownership prior to creation/retrieval.
     */
    async getOrCreatePlatformChannel(actor: Actor, platformId: string) {
        await this.assertPlatformMembership(actor.userId, platformId);

        const existing = await this.prisma.conversation.findUnique({ where: { platformId } });
        if (existing) return existing;

        return this.prisma.conversation.create({ data: { type: 'PLATFORM_CHANNEL', platformId } });
    }

    // ---- Generic Message Dispatch ----

    /**
     * Dispatches a message to a specific conversation (DIRECT or PLATFORM_CHANNEL) by ID.
     * Resolves recipient IDs and triggers notifications.
     */
    async sendToConversation(actor: Actor, conversationId: string, content: string, replyToId?: string) {
        const conversation = await this.findConversationOrThrow(conversationId);
        await this.assertCanAccessConversation(actor.userId, conversation);

        const recipientIds = await this.getRecipientIds(conversation, actor.userId);
        return this.createMessageAndNotify(conversation.id, actor.userId, content, recipientIds, replyToId);
    }

    // ---- User Conversation Feeds ----

    /**
     * Retrieves all active conversations (Directs + Platform Channels) accessible to the actor.
     * Computes unread message counts based on `conversationRead` timestamps and sorts by latest activity.
     */
    async listConversations(actor: Actor) {
        const directConvos = await this.prisma.conversation.findMany({
            where: { type: 'DIRECT', participants: { some: { userId: actor.userId } } },
            include: {
                participants: { include: { user: { select: { id: true, firstName: true, lastName: true } } } },
                messages: { orderBy: { createdAt: 'desc' }, take: 1 },
            },
        });

        // Collect platform IDs where actor is either the owner or an active member
        const ownedPlatformIds = (
            await this.prisma.platform.findMany({ where: { ownerId: actor.userId }, select: { id: true } })
        ).map((p) => p.id);
        const memberPlatformIds = (
            await this.prisma.platformMember.findMany({ where: { userId: actor.userId }, select: { platformId: true } })
        ).map((m) => m.platformId);
        const platformIds = Array.from(new Set([...ownedPlatformIds, ...memberPlatformIds]));

        const channelConvos = await this.prisma.conversation.findMany({
            where: { type: 'PLATFORM_CHANNEL', platformId: { in: platformIds } },
            include: {
                platform: { select: { id: true, name: true, slug: true } },
                messages: { orderBy: { createdAt: 'desc' }, take: 1 },
            },
        });

        const all = [...directConvos, ...channelConvos];

        // Compute unread message counts for each conversation relative to user's `lastReadAt`
        const withUnread = await Promise.all(
            all.map(async (conv) => {
                const read = await this.prisma.conversationRead.findUnique({
                    where: { conversationId_userId: { conversationId: conv.id, userId: actor.userId } },
                });
                const unreadCount = await this.prisma.message.count({
                    where: {
                        conversationId: conv.id,
                        senderId: { not: actor.userId },
                        createdAt: { gt: read?.lastReadAt ?? new Date(0) },
                    },
                });
                return { ...conv, unreadCount };
            }),
        );

        // Sort conversations by most recent message or creation timestamp
        return withUnread
            .sort((a, b) => {
                const aTime = a.messages[0]?.createdAt ?? a.createdAt;
                const bTime = b.messages[0]?.createdAt ?? b.createdAt;
                return new Date(bTime).getTime() - new Date(aTime).getTime();
            })
            .map((conv) => ({
                ...conv,
                // Keep the preview snippet's shape consistent with `getMessages()` - see
                // `serializeMessage()`. (Deliberately not filtering out a most-recent message
                // the actor hid "for me" here - unlike full history, a one-line preview
                // snippet of something they already saw isn't worth the extra query cost.)
                messages: conv.messages.map((m) => this.serializeMessage(m)),
            }));
    }

    /**
     * Calculates the total unread message count across all actor's conversations.
     */
    async getUnreadCount(actor: Actor) {
        const conversations = await this.listConversations(actor);
        return { count: conversations.reduce((sum, c) => sum + c.unreadCount, 0) };
    }

    // ---- Message Pagination & Read State ----

    /**
     * Retrieves messages for a conversation and automatically marks the conversation as read
     * by updating the actor's `lastReadAt` timestamp in `conversationRead`.
     */
    async getMessages(actor: Actor, conversationId: string, limit = 50) {
        const conversation = await this.findConversationOrThrow(conversationId);
        await this.assertCanAccessConversation(actor.userId, conversation);

        const messages = await this.prisma.message.findMany({
            where: {
                conversationId,
                // COMPLETENESS FIX: "delete for me" hides a message only for the user who
                // deleted it - never affects what any other participant sees.
                hiddenFor: { none: { userId: actor.userId } },
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: {
                sender: { select: { id: true, firstName: true, lastName: true } },
                replyTo: { include: { sender: { select: { id: true, firstName: true, lastName: true } } } },
            },
        });

        // Upsert read state tracking for the requesting user
        await this.prisma.conversationRead.upsert({
            where: { conversationId_userId: { conversationId, userId: actor.userId } },
            update: { lastReadAt: new Date() },
            create: { conversationId, userId: actor.userId, lastReadAt: new Date() },
        });

        return messages.reverse().map((m) => this.serializeMessage(m));
    }

    /**
     * COMPLETENESS FIX: implements the two-scope deletion the frontend already had UI for.
     * See `DeleteMessageDto` for the scope semantics.
     */
    async deleteMessage(actor: Actor, messageId: string, scope: 'me' | 'everyone') {
        const message = await this.prisma.message.findUnique({ where: { id: messageId } });
        if (!message) throw new NotFoundException('Message not found.');

        const conversation = await this.findConversationOrThrow(message.conversationId);
        await this.assertCanAccessConversation(actor.userId, conversation);

        if (scope === 'everyone') {
            if (message.senderId !== actor.userId) {
                throw new ForbiddenException('Only the sender can delete a message for everyone.');
            }
            await this.prisma.message.update({
                where: { id: messageId },
                data: { content: null, deletedForEveryoneAt: new Date() },
            });
            return { message: 'Message deleted for everyone.' };
        }

        // scope === 'me': hides it for the caller only, idempotently (re-deleting is a no-op,
        // not an error - the caller's intent, "I don't want to see this", is already satisfied).
        await this.prisma.messageHiddenFor.upsert({
            where: { messageId_userId: { messageId, userId: actor.userId } },
            update: {},
            create: { messageId, userId: actor.userId },
        });
        return { message: 'Message deleted for you.' };
    }

    /**
     * COMPLETENESS FIX: maps `deletedForEveryoneAt` (the DB column) to the boolean shape
     * `isDeletedForEveryone` the frontend's `Message` type already expects, for both a message
     * and its nested `replyTo` (if any and if not itself deleted-for-everyone already blanked).
     */
    private serializeMessage<
        T extends { deletedForEveryoneAt: Date | null; replyTo?: { deletedForEveryoneAt: Date | null } | null },
    >(message: T) {
        const { deletedForEveryoneAt, replyTo, ...rest } = message;
        return {
            ...rest,
            isDeletedForEveryone: deletedForEveryoneAt !== null,
            replyTo: replyTo
                ? (() => {
                      const { deletedForEveryoneAt: replyDeletedAt, ...replyRest } = replyTo;
                      return { ...replyRest, isDeletedForEveryone: replyDeletedAt !== null };
                  })()
                : (replyTo ?? null),
        };
    }

    // ---- Helpers ----

    /**
     * Helper retrieving a conversation by ID or throwing a 404 NotFoundException.
     */
    private async findConversationOrThrow(id: string) {
        const conversation = await this.prisma.conversation.findUnique({ where: { id } });
        if (!conversation) throw new NotFoundException('Conversation not found.');
        return conversation;
    }

    /**
     * Asserts actor's access rights to a conversation (either participant in a direct chat or member of a platform channel).
     */
    private async assertCanAccessConversation(
        userId: string,
        conversation: { id: string; type: string; platformId: string | null },
    ) {
        if (conversation.type === 'DIRECT') {
            const participant = await this.prisma.conversationParticipant.findUnique({
                where: { conversationId_userId: { conversationId: conversation.id, userId } },
            });
            if (!participant) throw new NotFoundException('Conversation not found.');
            return;
        }
        if (conversation.platformId) {
            await this.assertPlatformMembership(userId, conversation.platformId);
        }
    }

    /**
     * Asserts user is either the owner or an assigned member of a given platform.
     */
    private async assertPlatformMembership(userId: string, platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');
        if (platform.ownerId === userId) return;

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId } },
        });
        if (!membership) throw new NotFoundException('Platform not found.');
    }

    /**
     * Resolves recipient user IDs for a conversation, excluding the message sender.
     */
    private async getRecipientIds(
        conversation: { id: string; type: string; platformId: string | null },
        senderId: string,
    ): Promise<string[]> {
        if (conversation.type === 'DIRECT') {
            const participants = await this.prisma.conversationParticipant.findMany({
                where: { conversationId: conversation.id },
            });
            return participants.map((p) => p.userId).filter((id) => id !== senderId);
        }

        if (!conversation.platformId) return [];
        const platform = await this.prisma.platform.findUniqueOrThrow({ where: { id: conversation.platformId } });
        const members = await this.prisma.platformMember.findMany({ where: { platformId: conversation.platformId } });
        const ids = new Set([platform.ownerId, ...members.map((m) => m.userId)]);
        ids.delete(senderId);
        return Array.from(ids);
    }

    /**
     * Persists a new message entity in DB and triggers inactive recipient notifications in parallel.
     */
    private async createMessageAndNotify(
        conversationId: string,
        senderId: string,
        content: string,
        recipientIds: string[],
        replyToId?: string,
    ) {
        // COMPLETENESS FIX: verify the replied-to message actually belongs to THIS conversation
        // before linking it - without this check, a caller could pass any arbitrary message ID
        // (including one from a conversation they have no access to) and have it silently
        // attached as a "reply to" reference, leaking that message's existence/content into a
        // conversation the original participants never intended it to be visible in.
        if (replyToId) {
            const repliedMessage = await this.prisma.message.findUnique({ where: { id: replyToId } });
            if (!repliedMessage || repliedMessage.conversationId !== conversationId) {
                throw new NotFoundException('The message being replied to was not found in this conversation.');
            }
        }

        const message = await this.prisma.message.create({
            data: { conversationId, senderId, content, replyToId },
            include: {
                sender: { select: { id: true, firstName: true, lastName: true } },
                replyTo: { include: { sender: { select: { id: true, firstName: true, lastName: true } } } },
            },
        });

        await Promise.all(
            recipientIds.map((recipientId) =>
                this.notifyIfInactive(conversationId, recipientId, {
                    content,
                    sender: {
                        firstName: message.sender.firstName,
                        lastName: message.sender.lastName,
                    },
                }),
            ),
        );

        return this.serializeMessage(message);
    }

    /**
     * Evaluates user inactivity threshold and notification cooldowns before sending an email notification.
     */
    private async notifyIfInactive(
        conversationId: string,
        recipientId: string,
        message: { content: string; sender: { firstName: string; lastName: string } },
    ) {
        const recipient = await this.prisma.user.findUnique({ where: { id: recipientId } });
        if (!recipient) return;

        // Verify recipient inactivity based on configured threshold (e.g., 5 mins)
        const thresholdMin = this.configService.get<number>('MESSAGE_INACTIVITY_THRESHOLD_MIN', 5);
        const cutoff = new Date(Date.now() - thresholdMin * 60_000);
        const isInactive = !recipient.lastActiveAt || recipient.lastActiveAt < cutoff;
        if (!isInactive) return;

        // Enforce email cooldown period (e.g., max 1 email per 10 mins per conversation)
        const cooldownMin = this.configService.get<number>('MESSAGE_EMAIL_NOTIFICATION_COOLDOWN_MIN', 10);
        const read = await this.prisma.conversationRead.findUnique({
            where: { conversationId_userId: { conversationId, userId: recipientId } },
        });
        if (read?.lastEmailNotifiedAt && read.lastEmailNotifiedAt > new Date(Date.now() - cooldownMin * 60_000)) {
            return; // Already notified recently for this conversation
        }

        const frontendUrl = this.configService.get<string>('app.frontendUrl');
        const senderName = `${message.sender.firstName} ${message.sender.lastName}`;
        const preview = message.content.length > 140 ? `${message.content.slice(0, 140)}…` : message.content;

        await this.emailService.sendMail(
            recipient.workEmail,
            `New message from ${senderName}`,
            `${senderName} sent you a message:\n\n"${preview}"\n\nOpen BPG Control: ${frontendUrl}/messages`,
            `<p><strong>${senderName}</strong> sent you a message:</p><blockquote>${preview}</blockquote><p><a href="${frontendUrl}/messages">Open BPG Control</a></p>`,
        );

        // Record last email dispatch timestamp
        await this.prisma.conversationRead.upsert({
            where: { conversationId_userId: { conversationId, userId: recipientId } },
            update: { lastEmailNotifiedAt: new Date() },
            create: { conversationId, userId: recipientId, lastReadAt: new Date(0), lastEmailNotifiedAt: new Date() },
        });
    }
}