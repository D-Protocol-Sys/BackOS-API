import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';

export class CreateEntityDto {

    @IsString()
    @MinLength(1)
    @MaxLength(60)
    name!: string;

}