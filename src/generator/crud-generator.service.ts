import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { toPascalCase, toCamelCase } from '../common/utils/case.util';
import { FIELD_TYPE_VALIDATORS } from '../common/utils/field-type-validator-mapper.util';
import { RelationFieldMeta } from '../common/utils/relation-metadata.util';

interface EntityWithFields {
    tableName: string;
    isSchedulable: boolean;
    fields: { column: string; type: string; required: boolean }[];
}

@Injectable()
export class CrudGeneratorService {

    private schedulableDtoFields(): string {
        return `  @IsOptional()\n  @IsDateString()\n  publishAt?: string;\n\n  @IsOptional()\n  @IsDateString()\n  unpublishAt?: string;`;
    }

    async generateModulesForEntities(
        projectPath: string,
        entities: EntityWithFields[],
        relationFieldsByEntity: Map<string, RelationFieldMeta[]>,
        entityIdByTableName: Map<string, string>,
    ): Promise<string[]> {

        const moduleNames: string[] = [];

        for (const entity of entities) {
            const entityId = entityIdByTableName.get(entity.tableName)!;
            const relations = relationFieldsByEntity.get(entityId) ?? [];

            const modelName = toPascalCase(entity.tableName);
            const dirPath = path.join(projectPath, 'src', entity.tableName);
            await fs.mkdir(path.join(dirPath, 'dto'), { recursive: true });

            await Promise.all([

                fs.writeFile(
                    path.join(dirPath, 'dto', `create-${entity.tableName}.dto.ts`),
                    this.buildCreateDto(modelName, entity.fields, relations, entity.isSchedulable),
                ),
                fs.writeFile(
                    path.join(dirPath, 'dto', `update-${entity.tableName}.dto.ts`),
                    this.buildUpdateDto(modelName, entity.fields, relations, entity.isSchedulable),
                ),
                fs.writeFile(
                    path.join(dirPath, `${entity.tableName}.service.ts`),
                    this.buildService(modelName, entity.tableName, entity.fields, relations, entity.isSchedulable),
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

    // ---- DTO fields (champs métier classiques) ----

    private buildDtoFields(fields: EntityWithFields['fields'], forceOptional: boolean): string {
        return fields
            .map((field) => {
                const fieldName = toCamelCase(field.column);
                const spec = FIELD_TYPE_VALIDATORS[field.type as keyof typeof FIELD_TYPE_VALIDATORS];
                const isOptional = forceOptional || !field.required;

                const decorators = [...spec.decorators];
                if (isOptional) decorators.push('@IsOptional()');
                if (!isOptional && spec.tsType === 'string') decorators.push('@IsNotEmpty()');

                const decoratorLines = decorators.map((d) => `  ${d}`).join('\n');
                const questionMark = isOptional ? '?' : '';

                return `${decoratorLines}\n  ${fieldName}${questionMark}: ${spec.tsType};`;
            })
            .join('\n\n');
    }

    // ---- DTO fields liés aux relations ----

    private buildRelationDtoFields(relations: RelationFieldMeta[], forceOptional: boolean): string {
        return relations
            .filter((r) => r.hasScalarFk || r.isManyToMany)
            .map((r) => {
                if (r.hasScalarFk) {
                    const isOptional = forceOptional;
                    const questionMark = isOptional ? '?' : '';
                    const decorators = isOptional ? '  @IsOptional()\n  @IsUUID()' : '  @IsUUID()';
                    return `${decorators}\n  ${r.fieldName}Id${questionMark}: string;`;
                }
                return `  @IsOptional()\n  @IsArray()\n  @IsUUID('4', { each: true })\n  ${r.fieldName}Ids?: string[];`;
            })
            .join('\n\n');
    }

    private collectImports(fields: EntityWithFields['fields'], relations: RelationFieldMeta[]): string {
        const set = new Set<string>();
        for (const field of fields) {
            const spec = FIELD_TYPE_VALIDATORS[field.type as keyof typeof FIELD_TYPE_VALIDATORS];
            for (const decorator of spec.decorators) {
                const match = decorator.match(/@(\w+)/);
                if (match) set.add(match[1]);
            }
        }
        set.add('IsOptional');
        if (relations.some((r) => r.hasScalarFk || r.isManyToMany)) set.add('IsUUID');
        if (relations.some((r) => r.isManyToMany)) set.add('IsArray');
        return Array.from(set).sort().join(', ');
    }

    private buildCreateDto(
        modelName: string,
        fields: EntityWithFields['fields'],
        relations: RelationFieldMeta[],
        isSchedulable: boolean,
    ): string {
        const imports =  new Set(this.collectImports(fields, relations).split(', '));
        if (isSchedulable) imports.add('IsDateString');
        const body = [
            this.buildDtoFields(fields, false),
            this.buildRelationDtoFields(relations, false),
            isSchedulable ? this.schedulableDtoFields() : ''
        ]
        .filter(Boolean)
        .join('\n\n');

        return `
            import { ${Array.from(imports).sort().join(', ')} } from 'class-validator';

            export class Create${modelName}Dto {
                ${body}
            }
        `;
    }

    private buildUpdateDto(
        modelName: string,
        fields: EntityWithFields['fields'],
        relations: RelationFieldMeta[],
        isSchedulable: boolean
    ): string {
        const imports =  new Set(this.collectImports(fields, relations).split(', '));
        if (isSchedulable) imports.add('IsDateString');
        const body = [
            this.buildDtoFields(fields, true),
            this.buildRelationDtoFields(relations, true),
            isSchedulable ? this.schedulableDtoFields() : ''
        ]
        .filter(Boolean)
        .join('\n\n');

        return `
            import { ${Array.from(imports).sort().join(', ')} } from 'class-validator';

            export class Update${modelName}Dto {
                ${body}
            }
        `;
    }

    // ---- Service ----

    private buildService(
        modelName: string,
        tableName: string,
        fields: EntityWithFields['fields'],
        relations: RelationFieldMeta[],
        isSchedulable: boolean
    ): string {
        const modelCamel = toCamelCase(tableName);
        const dateFields = fields.filter(
            (f) => FIELD_TYPE_VALIDATORS[f.type as keyof typeof FIELD_TYPE_VALIDATORS].isDateField,
        );

        const m2mRelations = relations.filter((r) => r.isManyToMany);
        const directRelations = relations.filter((r) => r.hasScalarFk || r.isList);

        const needsTransform = dateFields.length > 0 || m2mRelations.length > 0;

        const dateLines = dateFields
            .map((f) => {
                const name = toCamelCase(f.column);
                return `    if (data.${name} !== undefined) data.${name} = new Date(data.${name} as string) as any;`;
            })
            .join('\n');

        const m2mCreateLines = m2mRelations
            .map((r) => {
                return `    if (data.${r.fieldName}Ids !== undefined) {
                    data.${r.fieldName} = { connect: (data.${r.fieldName}Ids as string[]).map((id) => ({ id })) };
                    delete data.${r.fieldName}Ids;
                }`;
            })
            .join('\n');

        const m2mUpdateLines = m2mRelations
            .map((r) => {
                return `    if (data.${r.fieldName}Ids !== undefined) {
                    data.${r.fieldName} = { set: (data.${r.fieldName}Ids as string[]).map((id) => ({ id })) };
                    delete data.${r.fieldName}Ids;
                }`;
            })
            .join('\n');

        const transformMethods = needsTransform
            ? `
                private toPrismaCreateData<T extends Record<string, unknown>>(dto: T): T {
                    const data = { ...dto };
                    ${dateLines}
                    ${m2mCreateLines}
                    return data;
                }

                private toPrismaUpdateData<T extends Record<string, unknown>>(dto: T): T {
                    const data = { ...dto };
                    ${dateLines}
                    ${m2mUpdateLines}
                    return data;
                }
            `
            : '';

        const createData = needsTransform ? 'this.toPrismaCreateData(dto)' : 'dto';
        const updateData = needsTransform ? 'this.toPrismaUpdateData(dto)' : 'dto';

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

        const includeClause =
            directRelations.length > 0
                ? `\n    include: { ${directRelations.map((r) => `${r.fieldName}: true`).join(', ')} },`
                : '';

        return `
            import { Injectable, NotFoundException } from '@nestjs/common';
            import { PrismaService } from '../prisma/prisma.service';
            import { Create${modelName}Dto } from './dto/create-${tableName}.dto';
            import { Update${modelName}Dto } from './dto/update-${tableName}.dto';

            @Injectable()
            export class ${modelName}Service {

                constructor(private readonly prisma: PrismaService) {}

                ${transformMethods}
                create(dto: Create${modelName}Dto) {
                    return this.prisma.${modelCamel}.create({ data: ${createData} as any${includeClause} });
                }

                ${findAllBody}

                async findOne(id: string) {
                    const record = await this.prisma.${modelCamel}.findUnique({ where: { id }${includeClause} });
                    if (!record) throw new NotFoundException('${modelName} introuvable.');
                    return record;
                }

                async update(id: string, dto: Update${modelName}Dto) {
                    await this.findOne(id);
                    return this.prisma.${modelCamel}.update({ where: { id }, data: ${updateData} as any${includeClause} });
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
