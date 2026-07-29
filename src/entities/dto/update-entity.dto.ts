import { IsString, MinLength, MaxLength } from 'class-validator';

export class UpdateEntityDto {

    @IsString()
    @MinLength(1)
    @MaxLength(60)
    name!: string;

}