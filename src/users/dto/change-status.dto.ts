// dto/change-status.dto.ts
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { StatusChangeReason } from '@prismamodels/enums';

export class ChangeUserStatusDto {

    @IsEnum(StatusChangeReason)
    reason!: StatusChangeReason;

    @IsOptional()
    @IsString()
    @MaxLength(500)
    comment?: string;
}