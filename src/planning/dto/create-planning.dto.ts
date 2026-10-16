import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PlanningScope } from '@prismamodels/client';

export class CreatePlanningDto {
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    name!: string;

    @IsOptional()
    @IsString()
    @MaxLength(2000)
    description?: string;

    @IsEnum(PlanningScope)
    scope!: PlanningScope;

    /**
     * Required only when scope === PLATFORM.
     * This is validated as a business rule in the service.
     */
    @IsOptional()
    @IsUUID()
    platformId?: string;

    /**
     * IANA timezone identifier.
     * Example: Europe/Paris
     */
    @IsOptional()
    @IsString()
    @MaxLength(100)
    timezone?: string;
}
