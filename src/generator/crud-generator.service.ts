import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { toPascalCase, toCamelCase } from '../common/utils/case.util';
import { FIELD_TYPE_VALIDATORS } from '../common/utils/field-type-validator-mapper.util';

interface EntityWithFields {
    tableName: string;
    isSchedulable: boolean;
    fields: {
        column: string;
        type: string;
        required: boolean;
    }[];
}

@Injectable()
export class CrudGeneratorService {

    private schedulableDtoFields(): string {
        return `  @IsOptional()\n  @IsDateString()\n  publishAt?: string;\n\n  @IsOptional()\n  @IsDateString()\n  unpublishAt?: string;`;
    }

    async generateModulesForEntities(
        projectPath: string,
        entities: EntityWithFields[],
    ): Promise<string[]> {

        const moduleNames: string[] = [];

        for (const entity of entities) {

            const modelName = toPascalCase(entity.tableName);
            const dirPath = path.join(projectPath, 'src', entity.tableName);
            await fs.mkdir(path.join(dirPath, 'dto'), { recursive: true });

            await Promise.all([

                fs.writeFile(
                    path.join(dirPath, 'dto', `create-${entity.tableName}.dto.ts`),
                    this.buildCreateDto(modelName, entity.fields, entity.isSchedulable),
                ),
                fs.writeFile(
                    path.join(dirPath, 'dto', `update-${entity.tableName}.dto.ts`),
                    this.buildUpdateDto(modelName, entity.fields, entity.isSchedulable),
                ),
                fs.writeFile(
                    path.join(dirPath, `${entity.tableName}.service.ts`),
                    this.buildService(modelName, entity.tableName, entity.fields, entity.isSchedulable),
                ),
                fs.writeFile(
                    path.join(dirPath, `${entity.tableName}.controller.ts`),
                    this.buildController(modelName, entity.tableName, entity.isSchedulable),
                ),
                fs.writeFile(
                    path.join(dirPath, `${entity.tableName}.module.ts`),
                    this.buildModule(modelName, entity.tableName),
                ),
            ]);

            moduleNames.push(modelName);
        }

        return moduleNames;
    }

    private buildDtoFields(fields: EntityWithFields['fields'], forceOptional: boolean): string {
        return fields
            .map((field) => {
                const fieldName = toCamelCase(field.column);
                const spec = FIELD_TYPE_VALIDATORS[field.type as keyof typeof FIELD_TYPE_VALIDATORS];
                const isOptional = forceOptional || !field.required;

                const decorators = [...spec.decorators];
                if (isOptional) decorators.push('@IsOptional()');
                if (!isOptional && (spec.tsType === 'string')) decorators.push('@IsNotEmpty()');

                const decoratorLines = decorators.map((d) => `  ${d}`).join('\n');
                const questionMark = isOptional ? '?' : '';

                return `${decoratorLines}\n  ${fieldName}${questionMark}: ${spec.tsType};`;
            })
            .join('\n\n');
    }

    private collectImports(fields: EntityWithFields['fields']): string {
        const set = new Set<string>();
        for (const field of fields) {
            const spec = FIELD_TYPE_VALIDATORS[field.type as keyof typeof FIELD_TYPE_VALIDATORS];
            for (const decorator of spec.decorators) {
                const match = decorator.match(/@(\w+)/);
                if (match) set.add(match[1]);
            }
        }
        set.add('IsOptional');
        return Array.from(set).sort().join(', ');
    }

    private buildCreateDto(modelName: string, fields: EntityWithFields['fields'], isSchedulable: boolean): string {
        const imports = new Set(this.collectImports(fields).split(', '));
        if (isSchedulable) imports.add('IsDateString');
        const body = [this.buildDtoFields(fields, false), isSchedulable ? this.schedulableDtoFields() : '']
            .filter(Boolean)
            .join('\n\n');

        return `
            import { ${Array.from(imports).sort().join(', ')} } from 'class-validator';

            export class Create${modelName}Dto {
                ${body}
            }
        `;
    }

    private buildUpdateDto(modelName: string, fields: EntityWithFields['fields'], isSchedulable: boolean): string {
        const imports = new Set(this.collectImports(fields).split(', '));
        if (isSchedulable) imports.add('IsDateString');
        const body = [this.buildDtoFields(fields, true), isSchedulable ? this.schedulableDtoFields() : '']
            .filter(Boolean)
            .join('\n\n');

        return `
            import { ${Array.from(imports).sort().join(', ')} } from 'class-validator';

            export class Update${modelName}Dto {
                ${body}
            }
        `;
    }

    private buildService(modelName: string, tableName: string, fields: EntityWithFields['fields'], isSchedulable: boolean): string {
        const modelCamel = toCamelCase(tableName);
        const dateFields = fields.filter(
            (f) => FIELD_TYPE_VALIDATORS[f.type as keyof typeof FIELD_TYPE_VALIDATORS].isDateField,
        );

        const transformMethod =
            dateFields.length > 0
                ? `
                    // Convertit les champs DATE (reçus en string ISO) en objet Date avant écriture Prisma
                    private toPrismaData<T extends Record<string, unknown>>(dto: T): T {
                        const data = { ...dto };
                        ${dateFields
                            .map((f) => {
                                const name = toCamelCase(f.column);
                                return `    if (data.${name} !== undefined) data.${name} = new Date(data.${name} as string) as any;`;
                            })
                            .join('\n')}
                        return data;
                    }
                `
                : '';

        const createData = dateFields.length > 0 ? 'this.toPrismaData(dto)' : 'dto';
        const updateData = dateFields.length > 0 ? 'this.toPrismaData(dto)' : 'dto';

        const findAllBody = isSchedulable
            ? ` findAll(includeUnpublished = false) {
                    const now = new Date();
                    return this.prisma.${modelCamel}.findMany({
                    where: includeUnpublished
                        ? {}
                        : {
                            AND: [
                            { OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
                            { OR: [{ unpublishAt: null }, { unpublishAt: { gt: now } }] },
                            ],
                        },
                        orderBy: { createdAt: 'desc' },
                    });
                }`
            : ` findAll() {
                    return this.prisma.${modelCamel}.findMany({ orderBy: { createdAt: 'desc' } });
                }`;

        return `
            import { Injectable, NotFoundException } from '@nestjs/common';
            import { PrismaService } from '../prisma/prisma.service';
            import { Create${modelName}Dto } from './dto/create-${tableName}.dto';
            import { Update${modelName}Dto } from './dto/update-${tableName}.dto';

            @Injectable()
            export class ${modelName}Service {

                constructor(private readonly prisma: PrismaService) {}

                ${transformMethod}
                create(dto: Create${modelName}Dto) {
                    return this.prisma.${modelCamel}.create({ data: ${createData} as any });
                }

                ${findAllBody}

                async findOne(id: string) {
                    const record = await this.prisma.${modelCamel}.findUnique({ where: { id } });
                    if (!record) throw new NotFoundException('${modelName} introuvable.');
                    return record;
                }

                async update(id: string, dto: Update${modelName}Dto) {
                    await this.findOne(id);
                    return this.prisma.${modelCamel}.update({ where: { id }, data: ${updateData} as any });
                }

                async remove(id: string) {
                    await this.findOne(id);
                    await this.prisma.${modelCamel}.delete({ where: { id } });
                    return { message: '${modelName} supprimé.' };
                }
            }
        `;
    }

    private buildController(modelName: string, tableName: string, isSchedulable: boolean): string {

        const findAllSignature = isSchedulable
            ? ` @Get()
                findAll(@Query('includeUnpublished') includeUnpublished?: string) {
                    return this.service.findAll(includeUnpublished === 'true');
                }`
            : ` @Get()
                findAll() {
                    return this.service.findAll();
                }`;

        const queryImport = isSchedulable ? ', Query' : '';

        return `
            import { Body, Controller, Delete, Get, Param, Patch, Post${queryImport} } from '@nestjs/common';
            import { ${modelName}Service } from './${tableName}.service';
            import { Create${modelName}Dto } from './dto/create-${tableName}.dto';
            import { Update${modelName}Dto } from './dto/update-${tableName}.dto';

            @Controller('${tableName}')
            export class ${modelName}Controller {

                constructor(private readonly service: ${modelName}Service) {}

                @Post()
                create(@Body() dto: Create${modelName}Dto) {
                    return this.service.create(dto);
                }

                ${findAllSignature}

                @Get(':id')
                findOne(@Param('id') id: string) {
                    return this.service.findOne(id);
                }

                @Patch(':id')
                update(@Param('id') id: string, @Body() dto: Update${modelName}Dto) {
                    return this.service.update(id, dto);
                }

                @Delete(':id')
                remove(@Param('id') id: string) {
                    return this.service.remove(id);
                }
            }
        `;
    }

    private buildModule(modelName: string, tableName: string): string {
        return `
            import { Module } from '@nestjs/common';
            import { ${modelName}Service } from './${tableName}.service';
            import { ${modelName}Controller } from './${tableName}.controller';

            @Module({
                controllers: [${modelName}Controller],
                providers: [${modelName}Service],
            })
            export class ${modelName}Module {}
        `;
    }
}