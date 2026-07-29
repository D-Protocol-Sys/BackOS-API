import {
    IsString, IsEnum, IsOptional, IsBoolean, IsInt, Min, MinLength, MaxLength,
} from 'class-validator';
import { FieldType } from '@prismamodels/client';

export class CreateFieldDto {

    @IsString()
    @MinLength(1)
    @MaxLength(60)
    name!: string;

    @IsEnum(FieldType)
    type!: FieldType;

    @IsOptional()
    @IsBoolean()
    required?: boolean;

    @IsOptional()
    @IsBoolean()
    unique?: boolean;

    @IsOptional()
    @IsString()
    @MaxLength(255)
    defaultValue?: string;

    @IsOptional()
    config?: Record<string, unknown>;
}