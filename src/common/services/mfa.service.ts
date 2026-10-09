import { Injectable } from '@nestjs/common';
import { TotpService } from '../utils/totp.service';
import { QrCodeService } from '../utils/qr-code.service';
import { CryptoService } from './crypto.service';

/**
 * High-level orchestration service for Multi-Factor Authentication (MFA).
 * * Combines TOTP generation, secret encryption, and QR Code provisioning.
 */
@Injectable()
export class MfaService {

    constructor(
        private readonly totp: TotpService,
        private readonly qrCode: QrCodeService,
        private readonly crypto: CryptoService,
    ) {}

    /**
     * Generates a complete 2FA enrollment payload for a user setting up MFA.
     * * Process Flow:
     * 1. Generates a new raw TOTP secret.
     * 2. Encrypts the secret for secure database storage.
     * 3. Constructs the `otpauth://` URI required by authenticator apps (e.g., Google Authenticator).
     * 4. Converts the URI into a Base64 QR Code Data URL for UI rendering.
     * * @param email - User's work email used as the account label in authenticator apps.
     * @returns Object containing the raw secret, encrypted secret, URI, and QR code Data URL.
     */
    async generateEnrollment(email: string) {
        // 1. Generate a new plain TOTP secret key
        const secret = this.totp.generateSecret();

        // 2. Encrypt the secret using symmetric encryption (AES-256-GCM)
        const encryptedSecret = this.crypto.encrypt(secret);

        // 3. Build the standard OTP Auth URI string
        const uri = this.totp.buildOtpauthUri(email, secret);

        // 4. Render the URI into a Base64 QR Code image string
        const qrCode = await this.qrCode.toDataUrl(uri);

        // Return enrollment credentials for both DB persistence and UI display
        return { 
            secret, 
            encryptedSecret, 
            uri, 
            qrCode 
        };
    }

    /**
     * Verifies a user-provided 6-digit TOTP token against their encrypted secret.
     * * Process Flow:
     * 1. Decrypts the stored encrypted secret key.
     * 2. Validates the provided token against the decrypted secret using time-based window checks.
     * * @param encryptedSecret - The AES-256-GCM encrypted TOTP secret retrieved from database.
     * @param token - The 6-digit verification code entered by the user.
     * @returns Promise resolving to `true` if the code is valid and within the time window, `false` otherwise.
     */
    async verify(encryptedSecret: string, token: string): Promise<boolean> {
        // 1. Decrypt the secret stored in the database
        const secret = this.crypto.decrypt(encryptedSecret);

        // 2. Delegate TOTP time-window verification to TotpService
        return this.totp.verify(secret, token);
    }

    /** Decrypts the secret and verifies the code, returning its time step (anti-replay, SEC-009). */
    async verifyWithStep(encryptedSecret: string, token: string): Promise<{ valid: boolean; timeStep?: number }> {
        const secret = this.crypto.decrypt(encryptedSecret);
        return this.totp.verifyWithStep(secret, token);
    }
}