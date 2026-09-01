import { IsEmail, IsEnum, IsOptional, IsString, IsUUID} from 'class-validator';
import { ClientType, ClientStatus } from '@prismamodels/client';

/**
 * Data Transfer Object (DTO) for client creation.
 * Defines and validates the payload shape expected by API endpoints.
 */
export class CreateClientDto {
    /**
     * Optional client type (e.g., INDIVIDUAL, COMPANY).
     * Validates that the input matches the ClientType enum values.
     */
    @IsEnum(ClientType)
    @IsOptional()
    type?: ClientType;

    /**
     * Optional company name.
     * Required for B2B clients, omitted for B2C.
     */
    @IsString()
    @IsOptional()
    companyName?: string;

    /**
     * Optional VAT Identification Number for tax compliance.
     */
    @IsString()
    @IsOptional()
    vatNumber?: string;

    /**
     * Optional official business registration identifier.
     */
    @IsString()
    @IsOptional()
    registrationNumber?: string;

    /**
     * Client's primary contact first name.
     * Mandatory string field.
     */
    @IsString()
    firstName!: string;

    /**
     * Client's primary contact last name.
     * Mandatory string field.
     */
    @IsString()
    lastName!: string;

    /**
     * Client's primary contact email address.
     * Ensures the input follows standard email format (user@domain.com).
     */
    @IsEmail()
    email!: string;

    /**
     * Optional contact phone number.
     */
    @IsString()
    @IsOptional()
    phone?: string;

    /**
     * Optional physical street address line.
     */
    @IsString()
    @IsOptional()
    streetAddress?: string;

    /**
     * Optional city name.
     */
    @IsString()
    @IsOptional()
    city?: string;

    /**
     * Optional postal or ZIP code.
     */
    @IsString()
    @IsOptional()
    postalCode?: string;

    /**
     * Optional country name or ISO code.
     */
    @IsString()
    @IsOptional()
    country?: string;

    /**
     * Optional lifecycle status (e.g., ACTIVE, INACTIVE, PENDING).
     * Validates against the ClientStatus enum.
     */
    @IsEnum(ClientStatus)
    @IsOptional()
    status?: ClientStatus;

    /**
     * Optional internal notes or remarks about the client.
     */
    @IsString()
    @IsOptional()
    notes?: string;

    /**
     * Optional foreign key referencing the associated platform.
     * Validates that the payload provides a valid UUID v4 format.
     */
    @IsUUID()
    @IsOptional()
    platformId?: string;

    /**
     * Optional custom scope definition for specific client services.
     */
    @IsString()
    @IsOptional()
    customServiceScope?: string;
}