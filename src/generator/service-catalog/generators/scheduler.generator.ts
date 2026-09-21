import * as fs from 'fs/promises';
import * as path from 'path';
import { BlueprintModuleRef } from './auth-user.generator';

export async function generateSchedulerFiles(
    projectPath: string,
    _config: Record<string, unknown>,
): Promise<BlueprintModuleRef[]> {

    await fs.mkdir(path.join(projectPath, 'src', 'tasks', 'dto'), { recursive: true });

    const files: Record<string, string> = {

        'src/tasks/dto/create-task.dto.ts': `
            import {
                IsString, IsEnum, IsOptional, IsDateString, IsObject, IsBoolean, ValidateIf,
            } from 'class-validator';

            export enum TaskActionType { EMAIL = 'email', WEBHOOK = 'webhook' }
            export enum TaskTriggerType { ONCE = 'once', CRON = 'cron' }

            export class CreateTaskDto {
                @IsString()
                name!: string;

                @IsEnum(TaskActionType)
                actionType!: TaskActionType;

                @IsEnum(TaskTriggerType)
                triggerType!: TaskTriggerType;

                @ValidateIf((o) => o.triggerType === TaskTriggerType.ONCE)
                @IsDateString()
                runAt?: string;

                @ValidateIf((o) => o.triggerType === TaskTriggerType.CRON)
                @IsString()
                cronExpression?: string;

                @IsObject()
                payload!: Record<string, unknown>;

                @IsOptional()
                @IsBoolean()
                isActive?: boolean;
            }
        `,

        'src/tasks/dto/update-task.dto.ts': `
            import { IsOptional, IsBoolean, IsObject, IsString } from 'class-validator';

            export class UpdateTaskDto {
                @IsOptional()
                @IsString()
                name?: string;

                @IsOptional()
                @IsBoolean()
                isActive?: boolean;

                @IsOptional()
                @IsObject()
                payload?: Record<string, unknown>;
            }
        `,

        'src/tasks/tasks.queue.ts': `
            export const TASKS_QUEUE_NAME = 'scheduled-tasks';
        `,

        'src/tasks/tasks.service.ts': `
            import { Injectable, NotFoundException } from '@nestjs/common';
            import { InjectQueue } from '@nestjs/bullmq';
            import { Queue } from 'bullmq';
            import { PrismaService } from '../prisma/prisma.service';
            import { CreateTaskDto, TaskTriggerType } from './dto/create-task.dto';
            import { UpdateTaskDto } from './dto/update-task.dto';
            import { TASKS_QUEUE_NAME } from './tasks.queue';

            @Injectable()
            export class TasksService {
                constructor(
                    private readonly prisma: PrismaService,
                    @InjectQueue(TASKS_QUEUE_NAME) private readonly queue: Queue,
                ) {}

                async create(dto: CreateTaskDto) {
                    const task = await this.prisma.scheduledTask.create({
                        data: {
                            name: dto.name,
                            actionType: dto.actionType,
                            triggerType: dto.triggerType,
                            runAt: dto.runAt ? new Date(dto.runAt) : null,
                            cronExpression: dto.cronExpression,
                            payload: dto.payload as any,
                            isActive: dto.isActive ?? true,
                        },
                    });
                    await this.scheduleJob(task);
                    return task;
                }

                async findAll() {
                    return this.prisma.scheduledTask.findMany({ orderBy: { createdAt: 'desc' } });
                }

                async findOne(id: string) {
                    const task = await this.prisma.scheduledTask.findUnique({ where: { id } });
                    if (!task) throw new NotFoundException('Tâche introuvable.');
                    return task;
                }

                async update(id: string, dto: UpdateTaskDto) {
                    await this.findOne(id);
                    const task = await this.prisma.scheduledTask.update({ where: { id }, data: dto as any });
                    await this.unscheduleJob(id);
                    if (task.isActive) await this.scheduleJob(task);
                    return task;
                }

                async remove(id: string) {
                    await this.findOne(id);
                    await this.unscheduleJob(id);
                    await this.prisma.scheduledTask.delete({ where: { id } });
                    return { message: 'Tâche supprimée.' };
                }

                private async scheduleJob(task: {
                    id: string; actionType: string; triggerType: string; isActive: boolean;
                    runAt: Date | null; cronExpression: string | null; payload: unknown;
                }) {
                    if (!task.isActive) return;

                    const jobData = { taskId: task.id, actionType: task.actionType, payload: task.payload };

                    if (task.triggerType === 'once' && task.runAt) {
                        const delay = Math.max(0, task.runAt.getTime() - Date.now());
                        await this.queue.add('run-task', jobData, { jobId: task.id, delay });
                    } else if (task.triggerType === 'cron' && task.cronExpression) {
                        await this.queue.add('run-task', jobData, {
                            jobId: task.id,
                            repeat: { pattern: task.cronExpression },
                        });
                    }
                }

                private async unscheduleJob(taskId: string) {
                    const repeatableJobs = await this.queue.getRepeatableJobs();
                    const match = repeatableJobs.find((j) => j.id === taskId);
                    if (match) await this.queue.removeRepeatableByKey(match.key);

                    const delayedJob = await this.queue.getJob(taskId);
                    if (delayedJob) await delayedJob.remove();
                }
            }
        `,

        'src/tasks/tasks.controller.ts': `
            import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
            import { TasksService } from './tasks.service';
            import { CreateTaskDto } from './dto/create-task.dto';
            import { UpdateTaskDto } from './dto/update-task.dto';
            import { ApiTags } from '@nestjs/swagger';

            @ApiTags('Task')
            @Controller('tasks')
            export class TasksController {
                constructor(private readonly tasksService: TasksService) {}

                @Post()
                create(@Body() dto: CreateTaskDto) {
                    return this.tasksService.create(dto);
                }

                @Get()
                findAll() {
                    return this.tasksService.findAll();
                }

                @Get(':id')
                findOne(@Param('id') id: string) {
                    return this.tasksService.findOne(id);
                }

                @Patch(':id')
                update(@Param('id') id: string, @Body() dto: UpdateTaskDto) {
                    return this.tasksService.update(id, dto);
                }

                @Delete(':id')
                remove(@Param('id') id: string) {
                    return this.tasksService.remove(id);
                }
            }
        `,

        'src/tasks/tasks.processor.ts': `
            import { Processor, WorkerHost } from '@nestjs/bullmq';
            import { Logger } from '@nestjs/common';
            import { Job } from 'bullmq';
            import * as nodemailer from 'nodemailer';
            import { PrismaService } from '../prisma/prisma.service';
            import { TASKS_QUEUE_NAME } from './tasks.queue';

            interface EmailTaskPayload {
                to: string;
                subject: string;
                text: string;
            }

            interface WebhookTaskPayload {
                url: string;
                body?: Record<string, unknown>;
            }

            interface TaskJobData {
                taskId: string;
                actionType: 'email' | 'webhook';
                payload: Record<string, unknown>;
            }

            function isEmailTaskPayload(payload: unknown): payload is EmailTaskPayload {
                if (!payload || typeof payload !== 'object') {
                    return false;
                }
                const value = payload as Record<string, unknown>;
                return (
                    typeof value.to === 'string' &&
                    typeof value.subject === 'string' &&
                    typeof value.text === 'string'
                );
            }

            function isWebhookTaskPayload(payload: unknown): payload is WebhookTaskPayload {
                if (!payload || typeof payload !== 'object') {
                    return false;
                }

                const value = payload as Record<string, unknown>;

                if (typeof value.url !== 'string') {
                    return false;
                }

                if (value.body !== undefined) {
                    if (
                        typeof value.body !== 'object' ||
                        value.body === null ||
                        Array.isArray(value.body)
                    ) {
                        return false;
                    }
                }

                return true;
            }

            @Processor(TASKS_QUEUE_NAME)
            export class TasksProcessor extends WorkerHost {
                private readonly logger = new Logger(TasksProcessor.name);

                constructor(private readonly prisma: PrismaService) {
                    super();
                }

                async process(job: Job<TaskJobData>): Promise<void> {
                    const { taskId, actionType, payload } = job.data;

                    try {
                        if (actionType === 'email') {
                            if (!isEmailTaskPayload(payload)) {
                                throw new Error(
                                    \`Invalid Payload email for task \${taskId}\`,
                                );
                            }
                            await this.runEmailAction(payload);
                        } else if (actionType === 'webhook') {
                            if (!isWebhookTaskPayload(payload)) {
                                throw new Error(
                                    \`Invalid payload webhook invalide for task \${taskId}\`,
                                );
                            }
                            await this.runWebhookAction(payload);
                        }
                        await this.prisma.scheduledTask.update({
                            where: { id: taskId },
                            data: { lastRunAt: new Date(), lastStatus: 'SUCCESS' },
                        });
                    } catch (error) {
                        this.logger.error(\`Task \${taskId} failed\`, error instanceof Error ? error.stack : String(error));
                        await this.prisma.scheduledTask.update({
                            where: { id: taskId },
                            data: { lastRunAt: new Date(), lastStatus: 'FAILED' },
                        });
                    }
                }

                private async runEmailAction(payload: EmailTaskPayload) {
                    const transporter = nodemailer.createTransport({
                        host: process.env.SMTP_HOST,
                        port: Number(process.env.SMTP_PORT),
                        secure: false,
                        auth: {
                            user: process.env.SMTP_USER,
                            pass: process.env.SMTP_PASSWORD,
                        },
                    });

                    await transporter.sendMail({
                        from: process.env.SMTP_FROM || process.env.SMTP_USER,
                        to: payload.to,
                        subject: payload.subject,
                        text: payload.text,
                    });
                }

                private async runWebhookAction(payload: WebhookTaskPayload) {
                    const response = await fetch(payload.url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(payload.body ?? {}),
                    });

                    if (!response.ok) {
                        throw new Error(
                            \`Webhook responded \${response.status}\`,
                        );
                    }
                }
            }
        `,

        'src/tasks/tasks.module.ts': `
            import { Module } from '@nestjs/common';
            import { BullModule } from '@nestjs/bullmq';
            import { TasksService } from './tasks.service';
            import { TasksController } from './tasks.controller';
            import { TasksProcessor } from './tasks.processor';
            import { TASKS_QUEUE_NAME } from './tasks.queue';

            @Module({
                imports: [
                    BullModule.forRootAsync({
                        useFactory: () => ({
                            connection: {
                            host: process.env.REDIS_HOST || 'localhost',
                            port: Number(process.env.REDIS_PORT) || 6379,
                            },
                        }),
                    }),
                    BullModule.registerQueue({ name: TASKS_QUEUE_NAME }),
                ],
                controllers: [TasksController],
                providers: [TasksService, TasksProcessor],
            })
            export class TasksModule {}
        `,
    };

    await Promise.all(
        Object.entries(files).map(([relativePath, content]) =>
            fs.writeFile(path.join(projectPath, relativePath), content),
        ),
    );

  return [{ name: 'TasksModule', importPath: './tasks/tasks.module' }];
}