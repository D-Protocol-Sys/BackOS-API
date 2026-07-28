import { IsString, MinLength, MaxLength, IsOptional } from 'class-validator';

export class UpdateRoleDto {

    @IsOptional()
    @IsString()
    @MinLength(2)
    @MaxLength(50)
    name?: string;

    @IsOptional()
    @IsString()
    @MaxLength(255)
    description?: string;
    
}