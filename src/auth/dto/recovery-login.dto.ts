import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Data Transfer Object for Emergency Recovery Authentication.
 */
export class RecoveryLoginDto {

    /**
     * Primary account identifier (work email or username).
     */
    @IsString()
    @IsNotEmpty()
    loginIdentifier!: string;

    /**
     * Plain text single-use emergency recovery code.
     */
    @IsString()
    @IsNotEmpty()
    recoveryCode!: string;

}