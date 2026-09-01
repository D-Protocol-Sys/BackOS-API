import { IsEnum, IsNumber, IsOptional, IsString, IsDateString } from 'class-validator';
import { ContractStatus } from '@prismamodels/client';

/**
 * Data Transfer Object (DTO) for contract creation.
 * Validates basic metadata, pricing, lifecycle dates, and status enum.
 */
export class CreateContractDto {
    /**
     * Title or human-readable identifier of the contract.
     * Mandatory string field.
     */
    @IsString()
    title!: string;

    /**
     * Detailed overview or notes about the agreement terms.
     */
    @IsString()
    @IsOptional()
    description?: string;

    /**
     * Unique reference identifier generated for tracking.
     * Mandatory string field.
     */
    @IsString()
    contractNumber!: string;

    /**
     * Monetary total charged for the services under contract.
     * Accepts floating-point numbers or integers.
     */
    @IsNumber()
    @IsOptional()
    billingAmount?: number;

    /**
     * ISO currency code (e.g., "USD", "EUR") for the billing amount.
     */
    @IsString()
    @IsOptional()
    currency?: string;

    /**
     * Internal key mapping the contract to a specific service package.
     */
    @IsString()
    @IsOptional()
    serviceKey?: string;

    /**
     * Timestamp recording when signatures were executed.
     * Must be a valid ISO 8601 date string (e.g., "2026-08-22T15:00:00Z").
     */
    @IsDateString()
    @IsOptional()
    signedAt?: string;

    /**
     * Date when the contract provisions officially take effect.
     * Must be a valid ISO 8601 date string.
     */
    @IsDateString()
    @IsOptional()
    startedAt?: string;

    /**
     * Expiration or termination date of the agreement.
     * Must be a valid ISO 8601 date string.
     */
    @IsDateString()
    @IsOptional()
    expiresAt?: string;

    /**
     * Direct link or URI pointing to the signed PDF document in storage.
     */
    @IsString()
    @IsOptional()
    documentUrl?: string;

    /**
     * Lifecycle status of the contract (e.g., DRAFT, ACTIVE, EXPIRED).
     * Validates against the ContractStatus enum.
     */
    @IsEnum(ContractStatus)
    @IsOptional()
    status?: ContractStatus;
}