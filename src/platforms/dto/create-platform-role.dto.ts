import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsString, Length } from 'class-validator';
import { PLATFORM_PERMISSIONS, PlatformPermissionKey } from '../../common/constants/platform-permissions.constant';

const GRANTABLE_KEYS = Object.values(PLATFORM_PERMISSIONS);

/**
 * Data Transfer Object used when an owner or an ADMIN creates a new custom role on a platform
 * (e.g. "Data Operator", "RH"). `permissions` is capped server-side to whatever the requesting
 * actor themselves currently holds on this platform - see `PlatformRolesService.create()`.
 */
export class CreatePlatformRoleDto {

    /** Display name of the role. Must be unique within the platform (case-sensitive). */
    @IsString()
    @Length(2, 50)
    name!: string;

    /** Permission keys to grant this role, from the platform permission catalog. */
    @IsArray()
    @ArrayUnique()
    @ArrayMaxSize(GRANTABLE_KEYS.length)
    @IsIn(GRANTABLE_KEYS, { each: true })
    permissions!: PlatformPermissionKey[];

}
