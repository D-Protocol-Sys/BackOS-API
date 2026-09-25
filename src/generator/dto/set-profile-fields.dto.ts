import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { FIELD_TYPE_TO_PRISMA } from '../../common/utils/field-type-mapper.util';
import { MAX_PROFILE_FIELDS } from '../service-catalog/profile-fields.util';

/**
 * One field of the profile that external users of a generated backend fill in after sign-up.
 */
export class ProfileFieldDto {
    /**
     * Display name of the field (e.g. "Date de naissance"). The database column is derived from it.
     * * `@MinLength(1)` / `@MaxLength(60)` - Keeps identifiers reasonable.
     */
    @IsString()
    @MinLength(1)
    @MaxLength(60)
    name!: string;

    /**
     * Kind of value: STRING, TEXT, NUMBER, BOOLEAN, DATE, IMAGE, VIDEO, MEDIA, FILE, URL or JSON.
     * * `@IsIn(...)` - Must be one of the platform's field types.
     */
    @IsString()
    @IsIn(Object.keys(FIELD_TYPE_TO_PRISMA))
    type!: string;

    /**
     * A required field does not block sign-up; it only keeps the profile "incomplete"
     * (`profileComplete: false`) until the user has filled it in.
     */
    @IsOptional()
    @IsBoolean()
    required?: boolean;

    /**
     * True when the field holds a list of values (interests, a gallery of images and videos, ...).
     */
    @IsOptional()
    @IsBoolean()
    isArray?: boolean;
}

/**
 * Payload of `PUT /platforms/:platformId/services/auth-user/profile-fields`.
 * The list REPLACES the current definition (send the fields you want to keep as well).
 */
export class SetProfileFieldsDto {
    @IsArray()
    @ArrayMaxSize(MAX_PROFILE_FIELDS)
    @ValidateNested({ each: true })
    @Type(() => ProfileFieldDto)
    fields!: ProfileFieldDto[];
}
