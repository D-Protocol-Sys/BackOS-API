import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { buildOtpEmail } from '../email/templates/otp-email.template';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

@Injectable()
export class AuthService {

    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
        private readonly emailService: EmailService,
    ) {}

    async requestOtp(dto: RequestOtpDto) {
        
        const user = await this.prisma.user.upsert({
            where: { email: dto.email },
            update: { firstName: dto.firstName, lastName: dto.lastName },
            create: {
                email: dto.email,
                firstName: dto.firstName,
                lastName: dto.lastName,
            },
        });

        
        const recentCode = await this.prisma.otpCode.findFirst({
            where: {
                userId: user.id,
                createdAt: { gt: new Date(Date.now() - 60_000) },
                consumedAt: null,
            },
            orderBy: { createdAt: 'desc' },
        });

        if (recentCode) {
            throw new BadRequestException(
                'Un code a déjà été envoyé récemment. Réessaie dans un instant.',
            );
        }

        const code = crypto.randomInt(100000, 999999).toString();
        const saltRounds = this.configService.getOrThrow<number>('otp.saltRounds');
        const codeHash = await bcrypt.hash(code, saltRounds);

        const expiresInMinutes = this.configService.get<number>(
            'otp.expiresInMinutes',
            10,
        );

        await this.prisma.otpCode.create({
            data: {
                userId: user.id,
                codeHash,
                expiresAt: new Date(Date.now() + expiresInMinutes * 60_000),
            },
        });

        const { subject, text, html } = buildOtpEmail(code, user.firstName);
        await this.emailService.sendMail(user.email, subject, text, html);

        return { message: 'Un code de vérification a été envoyé par email.' };

    }

    async verifyOtp(dto: VerifyOtpDto) {

        const user = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });

        if (!user) {
            throw new UnauthorizedException('Code invalide ou expiré.');
        }

        const otpCode = await this.prisma.otpCode.findFirst({
            where: {
                userId: user.id,
                consumedAt: null,
                expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: 'desc' },
        });

        const maxAttempts = this.configService.get<number>('otp.maxAttempts', 5);

        if (!otpCode || otpCode.attempts >= maxAttempts) {
            throw new UnauthorizedException('Code invalide ou expiré.');
        }

        const isValid = await bcrypt.compare(dto.code, otpCode.codeHash);

        if (!isValid) {
            await this.prisma.otpCode.update({
                where: { id: otpCode.id },
                data: { attempts: { increment: 1 } },
            });
            throw new UnauthorizedException('Code invalide ou expiré.');
        }

        await this.prisma.otpCode.update({
            where: { id: otpCode.id },
            data: { consumedAt: new Date() },
        });

        return this.issueTokens(user.id, user.email);

    }

    async refreshTokens(rawRefreshToken: string) {

        const tokenHash = this.hashToken(rawRefreshToken);

        const stored = await this.prisma.refreshToken.findUnique({
            where: { tokenHash },
            include: { user: true },
        });

        if (
            !stored ||
            stored.revokedAt !== null ||
            stored.expiresAt < new Date()
        ) {
            throw new UnauthorizedException('Session invalide, reconnecte-toi.');
        }

        await this.prisma.refreshToken.update({
            where: { id: stored.id },
            data: { revokedAt: new Date() },
        });

        return this.issueTokens(stored.user.id, stored.user.email);

    }

    async logout(userId: string, rawRefreshToken: string) {

        const tokenHash = this.hashToken(rawRefreshToken);

        await this.prisma.refreshToken.updateMany({
            where: { userId, tokenHash, revokedAt: null },
            data: { revokedAt: new Date() },
        });

        return { message: 'Déconnecté.' };

    }

    private async issueTokens(userId: string, email: string) {

        const accessToken = this.jwtService.sign({ sub: userId, email });

        const rawRefreshToken = crypto.randomBytes(64).toString('hex');
        const tokenHash = this.hashToken(rawRefreshToken);

        const expiresInDays = this.configService.get<number>(
            'jwt.refreshTokenExpiresInDays',
            7,
        );

        await this.prisma.refreshToken.create({
            data: {
                userId,
                tokenHash,
                expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
            },
        });

        return { accessToken, refreshToken: rawRefreshToken };

    }

    private hashToken(rawToken: string): string {
        return crypto.createHash('sha256').update(rawToken).digest('hex');
    }

}
