import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsString, IsOptional, MinLength, MaxLength } from 'class-validator';

/**
 * Data Transfer Object representing the payload required to provision a new user account.
 * Used by administrators or system processes during onboarding.
 */
export class CreateUserDto {
    /**
     * Primary professional work email address used for identity and system communications.
     */
    @ApiProperty({
        description: 'Primary corporate work email address associated with the account.',
        example: 'john.doe@company.com',
    })
    @IsEmail()
    workEmail!: string;

    /**
     * Secondary personal email address for recovery or personal correspondence.
     */
    @ApiProperty({
        description: 'Personal email address used for account recovery or direct contacts.',
        example: 'john.doe.personal@gmail.com',
    })
    @IsEmail()
    personalEmail!: string;

    /**
     * User's official or given first name.
     */
    @ApiProperty({
        description: "The user's given or first name.",
        example: 'John',
        minLength: 1,
        maxLength: 100,
    })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    firstName!: string;

    /**
     * User's official family or last name.
     */
    @ApiProperty({
        description: "The user's family or last name.",
        example: 'Doe',
        minLength: 1,
        maxLength: 100,
    })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    lastName!: string;

    /**
     * Optional unique custom username. If omitted, the system will auto-generate one.
     */
    @ApiPropertyOptional({
        description: 'Custom unique username handle. Auto-generated from name if omitted.',
        example: 'john.doe',
        minLength: 3,
        maxLength: 30,
    })
    @IsOptional()
    @IsString()
    @MinLength(3)
    @MaxLength(30)
    username?: string;
}