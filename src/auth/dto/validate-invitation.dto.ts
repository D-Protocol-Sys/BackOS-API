import { IsString } from 'class-validator';

export class ValidateInvitationDto {

    @IsString()
    token!: string;
    
}