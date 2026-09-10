import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsDateString, IsUrl, IsObject, MaxLength, IsEmail } from 'class-validator';

/**
 * Data Transfer Object representing the payload for updating a user's extended profile details.
 * Contains optional metadata managed directly by the end-user.
 */
export class UpdateProfileDetailsDto {
    /**
     * User's secondary personal email address.
     */
    @ApiPropertyOptional({
        description: 'Personal or secondary contact email address for the user.',
        example: 'john.doe.personal@gmail.com',
    })
    @IsOptional()
    @IsEmail()
    personalEmail?: string;

    /**
     * Short biography or personal description.
     */
    @ApiPropertyOptional({
        description: 'A brief self-written biography or personal statement.',
        example: 'Full-stack developer passionate about open-source software and scalable architecture.',
        maxLength: 1000,
    })
    @IsOptional()
    @IsString()
    @MaxLength(1000)
    bio?: string;

    /**
     * Contact phone number.
     */
    @ApiPropertyOptional({
        description: 'Primary contact phone number.',
        example: '+33612345678',
        maxLength: 30,
    })
    @IsOptional()
    @IsString()
    @MaxLength(30)
    phone?: string;

    /**
     * Date of birth formatted as an ISO date string (YYYY-MM-DD).
     */
    @ApiPropertyOptional({
        description: 'User birth date formatted as an ISO date string (YYYY-MM-DD).',
        example: '1995-06-15',
    })
    @IsOptional()
    @IsDateString()
    dateOfBirth?: string;

    /**
     * City, region, or specific physical location name.
     */
    @ApiPropertyOptional({
        description: "City, state, or regional location name.",
        example: 'Paris, Île-de-France',
        maxLength: 100,
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    location?: string;

    /**
     * Primary country of residence.
     */
    @ApiPropertyOptional({
        description: 'Country of residence.',
        example: 'France',
        maxLength: 100,
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    country?: string;

    /**
     * Personal or professional website URL.
     */
    @ApiPropertyOptional({
        description: "URL pointing to the user's personal website or portfolio.",
        example: 'https://johndoe.dev',
    })
    @IsOptional()
    @IsUrl({ require_tld: false })
    websiteUrl?: string;

    /**
     * Avatar image asset URL.
     */
    @ApiPropertyOptional({
        description: "URL pointing to the user's hosted avatar image.",
        example: 'https://cdn.platform.com/avatars/user-123.jpg',
    })
    @IsOptional()
    @IsUrl({ require_tld: false })
    avatarUrl?: string;

    /**
     * Employer or organization name, as self-reported by the user.
     */
    @ApiPropertyOptional({
        description: "The user's self-reported company or organization name.",
        example: 'Acme Corp',
        maxLength: 100,
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    company?: string;

    /**
     * Job title or role, as self-reported by the user.
     */
    @ApiPropertyOptional({
        description: "The user's self-reported job title.",
        example: 'Senior Product Designer',
        maxLength: 100,
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    jobTitle?: string;

    /**
     * Preferred display/interface language (ISO 639-1 code, e.g. 'fr', 'en').
     */
    @ApiPropertyOptional({
        description: 'Preferred interface language (ISO 639-1 code).',
        example: 'fr',
        maxLength: 10,
    })
    @IsOptional()
    @IsString()
    @MaxLength(10)
    language?: string;

    /**
     * Preferred IANA timezone (e.g. 'Europe/Paris').
     */
    @ApiPropertyOptional({
        description: 'Preferred IANA timezone identifier.',
        example: 'Europe/Paris',
        maxLength: 100,
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    timezone?: string;

    /**
     * Map of social network profiles (e.g. twitter, github, linkedin).
     */
    @ApiPropertyOptional({
        description: 'Key-value mapping of social media handles or profile links.',
        example: {
            github: 'https://github.com/johndoe',
            linkedin: 'https://linkedin.com/in/johndoe',
            twitter: 'https://x.com/johndoe',
        },
    })
    @IsOptional()
    @IsObject()
    socialLinks?: Record<string, string>;
}