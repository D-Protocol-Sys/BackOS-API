import { IsOptional, IsString, IsBoolean, MinLength, MaxLength } from 'class-validator';

export class AdminUpdateUserDto {
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