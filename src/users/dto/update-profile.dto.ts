import { IsOptional, IsString, MinLength, MaxLength } from 'class-validator';

export class UpdateProfileDto {
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    firstName?: string;

    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    lastName?: string;
}