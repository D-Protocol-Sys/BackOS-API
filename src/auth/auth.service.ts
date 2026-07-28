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
        
        const existingUser = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });

        const isBrandNewUser = !existingUser;

        const user = await this.prisma.user.upsert({
            where: { email: dto.email },
            update: { firstName: dto.firstName, lastName: dto.lastName },
            create: {
                email: dto.email,
                firstName: dto.firstName,
                lastName: dto.lastName,
            },
        });

        if (isBrandNewUser) {
            const totalUsers = await this.prisma.user.count();
            if (totalUsers === 1) {
                const ownerRole = await this.prisma.role.findUnique({
                    where: { name: 'owner' },
                });
                if (ownerRole) {
                    await this.prisma.userRole.create({
                        data: { userId: user.id, roleId: ownerRole.id },
                    });
                }
            }
        }
        
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

        if (!user.isActive) {
            throw new UnauthorizedException('Ce compte est désactivé.');
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

        const permissions = await this.getPermissionsForUser(userId);

        const accessToken = this.jwtService.sign({ sub: userId, email, permissions });

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

    private async getPermissionsForUser(userId: string): Promise<string[]> {
        const userRoles = await this.prisma.userRole.findMany({
            where: { userId },
            include: {
                role: {
                    include: { rolePermissions: { include: { permission: true } } },
                },
            },
        });

        const permissionSet = new Set<string>();

        for (const userRole of userRoles) {
            for (const rolePermission of userRole.role.rolePermissions) {
                permissionSet.add(rolePermission.permission.key);
            }
        }

        return Array.from(permissionSet);
    }

    private hashToken(rawToken: string): string {
        return crypto.createHash('sha256').update(rawToken).digest('hex');
    }

}
