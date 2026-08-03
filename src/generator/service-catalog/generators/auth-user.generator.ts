import * as fs from 'fs/promises';
import * as path from 'path';

export interface BlueprintModuleRef {
    name: string;
    importPath: string;
}

export async function generateAuthUserFiles(
    projectPath: string,
    config: Record<string, unknown>,
): Promise<BlueprintModuleRef[]> {

    await fs.mkdir(path.join(projectPath, 'src', 'auth', 'dto'), { recursive: true });
    await fs.mkdir(path.join(projectPath, 'src', 'auth', 'strategies'), { recursive: true });
    await fs.mkdir(path.join(projectPath, 'src', 'users'), { recursive: true });
    await fs.mkdir(path.join(projectPath, 'src', 'common', 'decorators'), { recursive: true });
    await fs.mkdir(path.join(projectPath, 'src', 'common', 'guards'), { recursive: true });

    const files: Record<string, string> = {

        'src/common/decorators/public.decorator.ts': `
            import { SetMetadata } from '@nestjs/common';

            export const IS_PUBLIC_KEY = 'isPublic';
            export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
        `,

        'src/common/decorators/current-user.decorator.ts': `
            import { createParamDecorator, ExecutionContext } from '@nestjs/common';

            export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
                return ctx.switchToHttp().getRequest().user;
            });
        `,

        'src/common/guards/jwt-auth.guard.ts': `
            import { Injectable, ExecutionContext } from '@nestjs/common';
            import { AuthGuard } from '@nestjs/passport';
            import { Reflector } from '@nestjs/core';
            import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

            @Injectable()
            export class JwtAuthGuard extends AuthGuard('jwt') {
                constructor(private readonly reflector: Reflector) {
                    super();
                }

                canActivate(context: ExecutionContext) {
                    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
                        context.getHandler(),
                        context.getClass(),
                    ]);
                    if (isPublic) return true;
                    return super.canActivate(context);
                }
            }
        `,

        'src/auth/dto/request-otp.dto.ts': `
            import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

            export class RequestOtpDto {
                @IsEmail()
                email!: string;

                @IsString()
                @MinLength(1)
                @MaxLength(100)
                firstName!: string;

                @IsString()
                @MinLength(1)
                @MaxLength(100)
                lastName!: string;
            }
        `,

        'src/auth/dto/verify-otp.dto.ts': `
            import { IsEmail, IsString, Length } from 'class-validator';

            export class VerifyOtpDto {
                @IsEmail()
                email!: string;

                @IsString()
                @Length(6, 6)
                code!: string;
            }
        `,

        'src/auth/dto/refresh-token.dto.ts': `
            import { IsString } from 'class-validator';

            export class RefreshTokenDto {
                @IsString()
                refreshToken!: string;
            }
        `,

        'src/auth/strategies/jwt.strategy.ts': `
            import { Injectable } from '@nestjs/common';
            import { PassportStrategy } from '@nestjs/passport';
            import { ExtractJwt, Strategy } from 'passport-jwt';

            @Injectable()
            export class JwtStrategy extends PassportStrategy(Strategy) {
                constructor() {
                    super({
                        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
                        ignoreExpiration: false,
                        secretOrKey: process.env.JWT_SECRET,
                    });
                }

                async validate(payload: { sub: string; email: string }) {
                    return { userId: payload.sub, email: payload.email };
                }
            }
        `,

        'src/auth/auth.service.ts': `
            import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
            import { JwtService } from '@nestjs/jwt';
            import * as bcrypt from 'bcrypt';
            import * as crypto from 'crypto';
            import * as nodemailer from 'nodemailer';
            import { PrismaService } from '../prisma/prisma.service';
            import { RequestOtpDto } from './dto/request-otp.dto';
            import { VerifyOtpDto } from './dto/verify-otp.dto';

            @Injectable()
            export class AuthService {
                private transporter = nodemailer.createTransport({
                    host: process.env.SMTP_HOST,
                    port: Number(process.env.SMTP_PORT),
                    secure: false,
                    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
                });

                constructor(
                    private readonly prisma: PrismaService,
                    private readonly jwtService: JwtService,
                ) {}

                async requestOtp(dto: RequestOtpDto) {
                    const user = await this.prisma.appUser.upsert({
                        where: { email: dto.email },
                        update: { firstName: dto.firstName, lastName: dto.lastName },
                        create: { email: dto.email, firstName: dto.firstName, lastName: dto.lastName },
                    });

                    const recentCode = await this.prisma.appOtpCode.findFirst({
                        where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 60_000) }, consumedAt: null },
                        orderBy: { createdAt: 'desc' },
                    });
                    if (recentCode) throw new BadRequestException('Un code a déjà été envoyé récemment.');

                    const code = crypto.randomInt(100000, 999999).toString();
                    const codeHash = await bcrypt.hash(code, 12);

                    await this.prisma.appOtpCode.create({
                        data: { userId: user.id, codeHash, expiresAt: new Date(Date.now() + 10 * 60_000) },
                    });

                    await this.transporter.sendMail({
                        from: process.env.SMTP_FROM || process.env.SMTP_USER,
                        to: user.email,
                        subject: 'Votre code de connexion',
                        text: \`Bonjour \${user.firstName}, votre code est : \${code} (valide 10 minutes)\`,
                        html: \`<p>Bonjour \${user.firstName},</p><p>Votre code : <strong>\${code}</strong></p><p>Valide 10 minutes.</p>\`,
                    });

                    return { message: 'Code envoyé par email.' };
                }

                async verifyOtp(dto: VerifyOtpDto) {

                    const user = await this.prisma.appUser.findUnique({ where: { email: dto.email } });
                    if (!user || !user.isActive) throw new UnauthorizedException('Code invalide ou expiré.');

                    const otpCode = await this.prisma.appOtpCode.findFirst({
                        where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date() } },
                        orderBy: { createdAt: 'desc' },
                    });
                    if (!otpCode || otpCode.attempts >= 5) throw new UnauthorizedException('Code invalide ou expiré.');

                    const isValid = await bcrypt.compare(dto.code, otpCode.codeHash);
                    if (!isValid) {
                        await this.prisma.appOtpCode.update({ where: { id: otpCode.id }, data: { attempts: { increment: 1 } } });
                        throw new UnauthorizedException('Code invalide ou expiré.');
                    }

                    await this.prisma.appOtpCode.update({ where: { id: otpCode.id }, data: { consumedAt: new Date() } });
                    return this.issueTokens(user.id, user.email);
                }

                async refreshTokens(rawRefreshToken: string) {
                    const tokenHash = this.hashToken(rawRefreshToken);
                    const stored = await this.prisma.appRefreshToken.findUnique({ where: { tokenHash }, include: { user: true } });

                    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
                        throw new UnauthorizedException('Session invalide.');
                    }

                    await this.prisma.appRefreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
                    return this.issueTokens(stored.user.id, stored.user.email);
                }

                private async issueTokens(userId: string, email: string) {
                    const accessToken = this.jwtService.sign({ sub: userId, email });
                    const rawRefreshToken = crypto.randomBytes(64).toString('hex');
                    const tokenHash = this.hashToken(rawRefreshToken);

                    await this.prisma.appRefreshToken.create({
                        data: { userId, tokenHash, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
                    });

                    return { accessToken, refreshToken: rawRefreshToken };
                }

                private hashToken(rawToken: string): string {
                    return crypto.createHash('sha256').update(rawToken).digest('hex');
                }
            }
        `,

        'src/auth/auth.controller.ts': `
            import { Body, Controller, Post } from '@nestjs/common';
            import { AuthService } from './auth.service';
            import { RequestOtpDto } from './dto/request-otp.dto';
            import { VerifyOtpDto } from './dto/verify-otp.dto';
            import { RefreshTokenDto } from './dto/refresh-token.dto';
            import { Public } from '../common/decorators/public.decorator';

            @Controller('auth')
            export class AuthController {
                constructor(private readonly authService: AuthService) {}

                @Public()
                @Post('otp/request')
                requestOtp(@Body() dto: RequestOtpDto) {
                    return this.authService.requestOtp(dto);
                }

                @Public()
                @Post('otp/verify')
                verifyOtp(@Body() dto: VerifyOtpDto) {
                    return this.authService.verifyOtp(dto);
                }

                @Public()
                @Post('refresh')
                refresh(@Body() dto: RefreshTokenDto) {
                    return this.authService.refreshTokens(dto.refreshToken);
                }
            }
        `,

        'src/auth/auth.module.ts': `
            import { Module } from '@nestjs/common';
            import { JwtModule } from '@nestjs/jwt';
            import { PassportModule } from '@nestjs/passport';
            import { AuthService } from './auth.service';
            import { AuthController } from './auth.controller';
            import { JwtStrategy } from './strategies/jwt.strategy';

            @Module({
                imports: [
                    PassportModule,
                    JwtModule.register({
                        secret: process.env.JWT_SECRET,
                        signOptions: { expiresIn: process.env.JWT_EXPIRES_IN || '15m' },
                    }),
                ],
                controllers: [AuthController],
                providers: [AuthService, JwtStrategy],
            })
            export class AuthModule {}
        `,

        'src/users/users.service.ts': `
            import { Injectable, NotFoundException } from '@nestjs/common';
            import { PrismaService } from '../prisma/prisma.service';

            @Injectable()
            export class UsersService {
                constructor(private readonly prisma: PrismaService) {}

                async getMe(userId: string) {
                    const user = await this.prisma.appUser.findUnique({
                        where: { id: userId },
                        select: { id: true, email: true, firstName: true, lastName: true, isActive: true, createdAt: true },
                    });
                    if (!user) throw new NotFoundException('Utilisateur introuvable.');
                    return user;
                }
            }
        `,

        'src/users/users.controller.ts': `
            import { Controller, Get } from '@nestjs/common';
            import { UsersService } from './users.service';
            import { CurrentUser } from '../common/decorators/current-user.decorator';

            @Controller('users')
            export class UsersController {
                constructor(private readonly usersService: UsersService) {}

                @Get('me')
                getMe(@CurrentUser() user: { userId: string }) {
                    return this.usersService.getMe(user.userId);
                }
            }
        `,

        'src/users/users.module.ts': `
            import { Module } from '@nestjs/common';
            import { UsersService } from './users.service';
            import { UsersController } from './users.controller';

            @Module({ controllers: [UsersController], providers: [UsersService] })
            export class UsersModule {}
        `,
    };

    await Promise.all(
        Object.entries(files).map(([relativePath, content]) =>
            fs.writeFile(path.join(projectPath, relativePath), content),
        ),
    );

    return [
        { name: 'AuthModule', importPath: './auth/auth.module' },
        { name: 'UsersModule', importPath: './users/users.module' },
    ];
}