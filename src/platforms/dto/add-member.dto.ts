import { IsUUID, IsEnum } from 'class-validator';
import { PlatformRole } from '@prismamodels/client';

export class AddMemberDto {
    @IsUUID()
    userId!: string;

    @IsEnum(PlatformRole)
    role!: PlatformRole;
}