import { IsUUID } from 'class-validator';

/**
 * Data Transfer Object used when reassigning a platform Planning's "responsible" user to
 * another active user - see `PlanningService.reassignResponsible()`.
 *
 * Introduced as part of the audit #1/#5 fix: `UsersService.hardDeleteUser()` now blocks
 * self/admin deletion of a user who is still the responsible party of a Planning, and this is
 * the endpoint that resolves that block (mirrors `TransferOwnershipDto` for platforms).
 */
export class ReassignResponsibleDto {
    /**
     * The unique identifier (UUID v4) of the user designated as the new responsible party.
     */
    @IsUUID()
    newResponsibleId!: string;
}
