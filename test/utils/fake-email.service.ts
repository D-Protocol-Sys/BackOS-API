import { Injectable } from '@nestjs/common';

export interface CapturedEmail {
    to: string;
    subject: string;
    text: string;
    html: string;
}

@Injectable()
export class FakeEmailService {
    public sentEmails: CapturedEmail[] = [];

    async sendMail(to: string, subject: string, text: string, html: string): Promise<void> {
        this.sentEmails.push({ to, subject, text, html });
    }

    getLastOtpCodeFor(email: string): string {
        const mail = [...this.sentEmails].reverse().find((m) => m.to === email);
        if (!mail) throw new Error(`Aucun email trouvé pour ${email}`);
        const match = mail.text.match(/\b\d{6}\b/);
        if (!match) throw new Error(`Aucun code OTP trouvé dans l'email pour ${email}`);
        return match[0];
    }

    reset() {
        this.sentEmails = [];
    }
}