import { IsString, IsOptional, IsUrl, MinLength, MaxLength } from 'class-validator';

export class CreatePlatformDto {

    @IsString()
    @MinLength(2)
    @MaxLength(100)
    name!: string;

    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;

    @IsOptional()
    @IsUrl({ require_tld: false })
    url?: string;

}