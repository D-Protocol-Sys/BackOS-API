import { IsString } from 'class-validator';

/**
 * Data Transfer Object (DTO) used to validate incoming payload
 * during authentication token refresh requests.
 */
export class RefreshTokenDto {

    /**
     * The refresh token string issued during authentication.
     * * @IsString() - Ensures the incoming property is a valid primitive string.
     * Prevents type confusion attacks (e.g., passing objects, arrays, or numbers).
     * * Note on `!:` (Definitely Assignment Assertion):
     * Tells TypeScript's strict null check compiler that this field will be supplied
     * at runtime by NestJS/class-validator, even if it lacks an inline initializer.
     */
    @IsString()
    refreshToken!: string;
    
}