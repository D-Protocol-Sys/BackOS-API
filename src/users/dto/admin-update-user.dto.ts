import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsEmail, MinLength, MaxLength, Matches } from 'class-validator';

/**
 * Data Transfer Object representing the payload for administrative user profile updates.
 * Restricted to administrators or users with elevated permissions.
 */
export class AdminUpdateUserDto {
    /**
     * Updated professional work email address.
     */
    @ApiPropertyOptional({
        description: 'The updated primary work email address for the user.',
        example: 'john.doe@company.com',
    })
    @IsOptional()
    @IsEmail()
    workEmail?: string;

    /**
     * Updated legal or given first name.
     */
    @ApiPropertyOptional({
        description: "The user's updated first name.",
        example: 'John',
        minLength: 1,
        maxLength: 100,
    })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    firstName?: string;

    /**
     * Updated family or last name.
     */
    @ApiPropertyOptional({
        description: "The user's updated last name.",
        example: 'Doe',
        minLength: 1,
        maxLength: 100,
    })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    lastName?: string;

    /**
     * Updated unique system username.
     */
    @ApiPropertyOptional({
        description: 'The updated unique handle or username for the user.',
        example: 'john.doe',
        minLength: 3,
        maxLength: 30,
    })
    @IsOptional()
    @IsString()
    @MinLength(3)
    @MaxLength(30)
    // SEC-025: no '@' - a username equal to another account's e-mail made login ambiguous.
    @Matches(/^[A-Za-z0-9._-]+$/, { message: 'username may only contain letters, digits, ".", "_" and "-".' })
    username?: string;

    /**
     * Target platform ID or slug to which the user is assigned by the owner.
     */
    @ApiPropertyOptional({
        description: 'The platform identifier or organization slug to which this user is assigned.',
        example: 'platform-alpha-prod',
        maxLength: 100,
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    company?: string;

    /**
     * Updated professional job title or role within the platform/organization.
     */
    @ApiPropertyOptional({
        description: "The user's assigned job title or designation within the targeted platform.",
        example: 'Senior Product Designer',
        maxLength: 100,
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    jobTitle?: string;
}
