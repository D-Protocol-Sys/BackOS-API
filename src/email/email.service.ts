import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService implements OnModuleInit {

    private readonly logger = new Logger(EmailService.name);
    private transporter: nodemailer.Transporter;

    constructor(private readonly configService: ConfigService) {

        this.transporter = nodemailer.createTransport({
            host: this.configService.get<string>('mail.host'),
            port: this.configService.get<number>('mail.port'),
            secure: this.configService.get<string>('mail.secure') === 'true',
            auth: {
                user: this.configService.get<string>('mail.user'),
                pass: this.configService.get<string>('mail.password'),
            },
        });
    }

    async onModuleInit() {
        try {
            await this.transporter.verify();
            this.logger.log('Connexion SMTP vérifiée avec succès');
        } catch (err) {
            this.logger.error(
                'Impossible de se connecter au serveur SMTP. Vérifie tes identifiants dans .env',
                err instanceof Error ? err.message : err,
            );
        }
    }

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