import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

export class RequestOtpDto {
    @IsEmail()
    email!: string;

    @IsString()
    @MinLength(1)
    @MaxLength(100)
    firstName!: string;

    @IsString()
    @MinLength(1)
    @MaxLength(100)
    lastName!: string;
}