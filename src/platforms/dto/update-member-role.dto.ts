import { IsUUID } from 'class-validator';

/**
 * Data Transfer Object (DTO) used when updating the access role of an existing member within a
 * platform. `platformRoleId` must point to a `PlatformRole` row belonging to that same platform.
 */
export class UpdateMemberRoleDto {
    @IsUUID()
    platformRoleId!: string;
}
