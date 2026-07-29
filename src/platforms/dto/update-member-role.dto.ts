import { IsEnum } from 'class-validator';
import { PlatformRole } from '@prismamodels/client';

export class UpdateMemberRoleDto {

    @IsEnum(PlatformRole)
    role!: PlatformRole;
    
}