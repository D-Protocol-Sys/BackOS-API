import * as fs from 'fs/promises';
import * as path from 'path';
import { BlueprintModuleRef } from './auth-user.generator';

export async function generateMailingFiles(
    projectPath: string,
    config: Record<string, unknown>,
): Promise<BlueprintModuleRef[]> {

    await fs.mkdir(path.join(projectPath, 'src', 'mail', 'dto'), { recursive: true });

    const requiresAuth = config.requiresAuth === true || config.requiresAuth === 'true';
    const guardImport = requiresAuth
        ? `import { UseGuards } from '@nestjs/common';\nimport { JwtAuthGuard } from '../common/guards/jwt-auth.guard';\n`
        : '';
    const guardDecorator = requiresAuth ? '  @UseGuards(JwtAuthGuard)\n' : '';

    const files: Record<string, string> = {

        'src/mail/mail.service.ts': `
            import { Injectable, Logger } from '@nestjs/common';
            import * as nodemailer from 'nodemailer';

            @Injectable()
            export class MailService {
                private readonly logger = new Logger(MailService.name);
                private transporter = nodemailer.createTransport({
                    host: process.env.SMTP_HOST,
                    port: Number(process.env.SMTP_PORT),
                    secure: false,
                    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
                });

                async send(to: string, subject: string, text: string, html?: string) {
                    await this.transporter.sendMail({
                        from: process.env.SMTP_FROM || process.env.SMTP_USER,
                        to,
                        subject,
                        text,
                        html: html || text,
                    });
                    this.logger.log(\`Email envoyé à \${to} : "\${subject}"\`);
                }
            }
        `,

        'src/mail/dto/send-mail.dto.ts': `
            import { IsEmail, IsString, MinLength, MaxLength, IsOptional } from 'class-validator';

            export class SendMailDto {
                @IsEmail()
                to!: string;

                @IsString()
                @MinLength(1)
                @MaxLength(200)
                subject!: string;

                @IsString()
                @MinLength(1)
                text!: string;

                @IsOptional()
                @IsString()
                html?: string;
            }
        `,

        'src/mail/mail.controller.ts': `
            import { Body, Controller, Post } from '@nestjs/common';
            ${guardImport}import { MailService } from './mail.service';
            import { SendMailDto } from './dto/send-mail.dto';

            @Controller('mail')
            export class MailController {
                constructor(private readonly mailService: MailService) {}

                ${guardDecorator}  @Post('send')
                async send(@Body() dto: SendMailDto) {
                    await this.mailService.send(dto.to, dto.subject, dto.text, dto.html);
                    return { message: 'Email envoyé.' };
                }
            }
        `,

        'src/mail/mail.module.ts': `
            import { Global, Module } from '@nestjs/common';
            import { MailService } from './mail.service';
            import { MailController } from './mail.controller';

            @Global()
            @Module({
                controllers: [MailController],
                providers: [MailService],
                exports: [MailService],
            })
            export class MailModule {}
        `,
    };

    await Promise.all(
        Object.entries(files).map(([relativePath, content]) =>
            fs.writeFile(path.join(projectPath, relativePath), content),
        ),
    );

    return [{ name: 'MailModule', importPath: './mail/mail.module' }];
}