import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { PLATFORM_PERMISSIONS, PlatformPermissionKey } from '../../common/constants/platform-permissions.constant';

const GRANTABLE_KEYS = Object.values(PLATFORM_PERMISSIONS);

/**
 * Data Transfer Object used to rename a custom platform role and/or replace its permission set.
 * Never usable on the system "ADMIN" role - see `PlatformRolesService.update()`.
 */
export class UpdatePlatformRoleDto {
    @IsOptional()
    @IsString()
    @Length(2, 50)
    name?: string;

    /** When provided, REPLACES the role's entire permission set (not a merge). */
    @IsOptional()
    @IsArray()
    @ArrayUnique()
    @ArrayMaxSize(GRANTABLE_KEYS.length)
    @IsIn(GRANTABLE_KEYS, { each: true })
    permissions?: PlatformPermissionKey[];
}
