import { IsUUID, IsEnum, IsString, MinLength, MaxLength } from 'class-validator';
import { RelationType } from '@prismamodels/client';

export class CreateRelationDto {
    
    @IsEnum(RelationType)
    type!: RelationType;

    @IsUUID()
    entityAId!: string;

    @IsUUID()
    entityBId!: string;

    @IsString()
    @MinLength(1)
    @MaxLength(60)
    fieldNameOnA!: string;

    @IsString()
    @MinLength(1)
    @MaxLength(60)
    fieldNameOnB!: string;
}