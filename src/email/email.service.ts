import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * Service handling email dispatch via Nodemailer and SMTP.
 * Implements `OnModuleInit` lifecycle hook to verify connection readiness upon application startup.
 */
@Injectable()
export class EmailService implements OnModuleInit {

    // Contextual logger instance for EmailService operations
    private readonly logger = new Logger(EmailService.name);
    // Nodemailer transporter instance used to manage SMTP connection and dispatch emails
    private transporter: nodemailer.Transporter;

    /**
     * @param configService - NestJS Configuration Service used to retrieve environment variables.
     */
    constructor(private readonly configService: ConfigService) {

        // Instantiates Nodemailer transporter with dynamic configuration loaded from environment settings
        this.transporter = nodemailer.createTransport({
            host: this.configService.get<string>('mail.host'),
            port: this.configService.get<number>('mail.port'),
            secure: this.configService.get<string>('mail.secure') === 'true', // Parses string boolean representation safely
            auth: {
                user: this.configService.get<string>('mail.user'),
                pass: this.configService.get<string>('mail.password'),
            },
        });
    }

    /**
     * NestJS Lifecycle Hook invoked automatically after the module has been initialized.
     * Verifies active SMTP handshake and credential validity at startup.
     */
    async onModuleInit() {
        try {
            // Initiates connection handshake with the target SMTP server
            await this.transporter.verify();
            this.logger.log('SMTP connection verified successfully.');
        } catch (err) {
            // Logs detailed error if authentication or connection fails, preventing silent runtime failures
            this.logger.error(
                'Failed to connect to SMTP server. Please check your credentials in .env',
                err instanceof Error ? err.message : err,
            );
        }
    }

    /**
     * Sends an email payload through the configured SMTP transporter.
     * * @param to - Recipient's email address.
     * @param subject - Message subject line.
     * @param text - Plaintext representation of the body content.
     * @param html - HTML formatted representation of the body content.
     */
    async sendMail(to: string, subject: string, text: string, html: string) {
        await this.transporter.sendMail({
            from: this.configService.get<string>('mail.from'),
            to,
            subject,
            text,
            html,
        });
    }
}