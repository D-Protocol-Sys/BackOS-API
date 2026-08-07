// dto/process-disabled-user.dto.ts
import { IsEnum } from 'class-validator';

export enum RetentionAction {
    ANONYMIZE = 'ANONYMIZE',
    DELETE = 'DELETE',
}

export class ProcessDisabledUserDto {
    @IsEnum(RetentionAction)
    action!: RetentionAction;
}