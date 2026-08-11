import { IsEnum } from 'class-validator';
import { PlatformRole } from '@prismamodels/client';

/**
 * Data Transfer Object (DTO) used when updating the access role 
 * of an existing member within a platform or workspace.
 */
export class UpdateMemberRoleDto {

    /**
     * The updated platform role to assign to the member.
     * Enforces that the value matches a valid key from the `PlatformRole` database enum.
     */
    @IsEnum(PlatformRole)
    role!: PlatformRole;
    
}