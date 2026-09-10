import { IsIn } from 'class-validator';

/**
 * Data Transfer Object for `DELETE /messages/:id`.
 *
 * COMPLETENESS FIX: the frontend already had a fully-built delete UI (see
 * `ConversationThread.tsx`) offering two distinct scopes, matched here:
 *   - `'me'`: hides the message for the caller only (`MessageHiddenFor`); every other
 *     participant keeps seeing it normally.
 *   - `'everyone'`: only the original sender may do this (enforced in
 *     `MessagesService.deleteMessage()`); clears the message content for all participants.
 */
export class DeleteMessageDto {

    @IsIn(['me', 'everyone'])
    scope!: 'me' | 'everyone';

}
