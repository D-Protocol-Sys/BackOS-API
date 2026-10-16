import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as QRCode from 'qrcode';

/**
 * Utility service dedicated to generating 2D QR Codes in various formats.
 * * Uses the `qrcode` library under the hood to process URIs or plain strings.
 */
@Injectable()
export class QrCodeService {
    /**
     * Converts a string payload into a Base64-encoded Data URL representation of a QR Code.
     * * Primary Use Case: Direct rendering in HTML/React frontend image tags (`<img src="..." />`).
     * * @param content - Plain text or URI (e.g., `otpauth://...`) to encode into the QR Code.
     * @returns Promise resolving to a Base64 Data URL string (`data:image/png;base64,...`).
     * @throws InternalServerErrorException if QR code generation fails.
     */
    async toDataUrl(content: string): Promise<string> {
        try {
            // Generate Base64 Data URL directly from content string
            return await QRCode.toDataURL(content);
        } catch {
            throw new InternalServerErrorException('Failed to generate QR Code Data URL.');
        }
    }

    /**
     * Converts a string payload into a binary PNG Buffer representation of a QR Code.
     * * Primary Use Case: PDF generation, file system operations, or streaming as HTTP response attachments.
     * * @param content - Plain text or URI (e.g., `otpauth://...`) to encode into the QR Code.
     * @returns Promise resolving to a Node.js binary Buffer containing the PNG image data.
     * @throws InternalServerErrorException if QR code generation fails.
     */
    async toBuffer(content: string): Promise<Buffer> {
        try {
            // Generate binary PNG Buffer directly from content string
            return await QRCode.toBuffer(content);
        } catch {
            throw new InternalServerErrorException('Failed to generate QR Code Buffer.');
        }
    }
}
