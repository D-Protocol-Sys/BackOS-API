// dto/process-disabled-user.dto.ts
import { IsEnum } from 'class-validator';

/**
 * Enumeration defining allowable GDPR/data retention actions 
 * for handling disabled user accounts.
 */
export enum RetentionAction {
    ANONYMIZE = 'ANONYMIZE',
    DELETE = 'DELETE',
}

/**
 * Data Transfer Object (DTO) used when processing an inactive or disabled user account,
 * determining whether to scrub PII (anonymize) or permanently purge the record.
 */
export class ProcessDisabledUserDto {
    /**
     * The retention action to execute on the disabled user account.
     * Must be a valid value from the `RetentionAction` enum (`ANONYMIZE` or `DELETE`).
     */
    @IsEnum(RetentionAction)
    action!: RetentionAction;
}