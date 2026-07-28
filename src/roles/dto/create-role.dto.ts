import { IsString, MinLength, MaxLength, IsOptional, IsArray, ArrayNotEmpty, IsString as IsStringEach, IsInt, Min } from 'class-validator';

export class CreateRoleDto {

    @IsString()
    @MinLength(2)
    @MaxLength(50)
    name!: string;

    @IsOptional()
    @IsString()
    @MaxLength(255)
    description?: string;

    @IsInt()
    @Min(1)
    level!: number;

    @IsArray()
    @ArrayNotEmpty()
    @IsStringEach({ each: true })
    permissionKeys!: string[];
    
}