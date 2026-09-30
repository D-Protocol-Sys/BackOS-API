import { IsUUID } from 'class-validator';

/**
 * Data Transfer Object (DTO) used when adding a new member to a platform or assigning them a
 * specific access role. `platformRoleId` points to one of that platform's own `PlatformRole`
 * rows (the system "ADMIN" role, or a custom role created via `PlatformRolesController`) - see
 * `PlatformsService.assertCanGrantRole()` for the rules on who can grant which role.
 */
export class AddMemberDto {

    /** The unique identifier (UUID v4) of the target user to add. */
    @IsUUID()
    userId!: string;

    /** The id of the `PlatformRole` (on this same platform) to assign the user. */
    @IsUUID()
    platformRoleId!: string;

}
