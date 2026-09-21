import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { toPascalCase, toCamelCase } from '../common/utils/case.util';
import { FIELD_TYPE_VALIDATORS } from '../common/utils/field-type-validator-mapper.util';
import { RelationFieldMeta } from '../common/utils/relation-metadata.util';

/**
 * Interface defining the schema definition and authorization settings of an entity.
 */
interface EntityWithFields {
    tableName: string;
    isSchedulable: boolean;
    authProtectCreate: boolean;
    authProtectRead: boolean;
    authProtectUpdate: boolean;
    authProtectDelete: boolean;
    fields: { column: string; type: string; required: boolean }[];
}

/**
 * NestJS Service driving the dynamic code generation for end-to-end CRUD modules.
 * Produces DTOs, Controllers, Services, and Modules tailored to target entity schemas.
 */
@Injectable()
export class CrudGeneratorService {

    /**
     * Generates DTO properties supporting schedulable/publishable entities (`publishAt`, `unpublishAt`).
     * @returns String template representing DTO property entries.
     */
    private schedulableDtoFields(): string {
        return `  @IsOptional()\n  @IsDateString()\n  publishAt?: string;\n\n  @IsOptional()\n  @IsDateString()\n  unpublishAt?: string;`;
    }

    /**
     * Asynchronously generates disk files for NestJS modules corresponding to each entity.
     * * @param projectPath - Target project root directory path.
     * @param entities - Entity metadata collection.
     * @param relationFieldsByEntity - Map associating entity IDs with their relation metadata.
     * @param entityIdByTableName - Mapping lookup linking table names to entity IDs.
     * @returns Array of generated PascalCase module class names.
     */
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

            // Concurrent execution writing generated TypeScript files for each module component
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
                    this.buildController(modelName, entity.tableName, entity.isSchedulable, {
                        create: entity.authProtectCreate,
                        read: entity.authProtectRead,
                        update: entity.authProtectUpdate,
                        delete: entity.authProtectDelete,
                    }),
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

    // ---- DTO fields (Standard Business Fields) ----

    /**
     * Builds TypeScript property definitions and `class-validator` decorators for standard fields.
     */
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
                const definiteAssignment = isOptional ? '' : '!';

                return `${decoratorLines}\n  ${fieldName}${questionMark}${definiteAssignment}: ${spec.tsType};`;
            })
            .join('\n\n');
    }

    // ---- DTO fields (Relation FKs / Many-to-Many IDs) ----

    /**
     * Builds DTO field rules handling relational properties (Foreign Keys and Many-to-Many ID arrays).
     */
    private buildRelationDtoFields(relations: RelationFieldMeta[], forceOptional: boolean): string {
        return relations
            .filter((r) => r.hasScalarFk || r.isManyToMany)
            .map((r) => {
                if (r.hasScalarFk) {
                    const isOptional = forceOptional;
                    const questionMark = isOptional ? '?' : '';
                    const definiteAssignment = isOptional ? '' : '!';
                    const decorators = isOptional ? '  @IsOptional()\n  @IsUUID()' : '  @IsUUID()';
                    return `${decorators}\n  ${r.fieldName}Id${questionMark}${definiteAssignment}: string;`;
                }
                return `  @IsOptional()\n  @IsArray()\n  @IsUUID('4', { each: true })\n  ${r.fieldName}Ids?: string[];`;
            })
            .join('\n\n');
    }

    /**
     * Inspects target fields/relations to deduce required `class-validator` imports dynamically.
     */
    private collectImports(fields: EntityWithFields['fields'], relations: RelationFieldMeta[]): string {
        const set = new Set<string>();
        for (const field of fields) {
            const spec = FIELD_TYPE_VALIDATORS[field.type as keyof typeof FIELD_TYPE_VALIDATORS];
            for (const decorator of spec.decorators) {
                const match = decorator.match(/@(\w+)/);
                if (match) set.add(match[1]);
            }
            // Required string fields receive @IsNotEmpty()
            if (field.required && spec.tsType === 'string') {
                set.add('IsNotEmpty');
            }
        }
        set.add('IsOptional');
        if (relations.some((r) => r.hasScalarFk || r.isManyToMany)) set.add('IsUUID');
        if (relations.some((r) => r.isManyToMany)) set.add('IsArray');
        return Array.from(set).sort().join(', ');
    }

    /**
     * Generates source code for the entity's `CreateDto` class.
     */
    private buildCreateDto(
        modelName: string,
        fields: EntityWithFields['fields'],
        relations: RelationFieldMeta[],
        isSchedulable: boolean,
    ): string {
        const imports = new Set(this.collectImports(fields, relations).split(', '));
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

    /**
     * Generates source code for the entity's `UpdateDto` class with optional property markers.
     */
    private buildUpdateDto(
        modelName: string,
        fields: EntityWithFields['fields'],
        relations: RelationFieldMeta[],
        isSchedulable: boolean
    ): string {
        const imports = new Set(this.collectImports(fields, relations).split(', '));
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

    /**
     * Generates source code for the entity's service class (Prisma queries and data transformers).
     */
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
                // T is deliberately unconstrained (just "object", not "Record<string, unknown>"):
                // the generated DTO classes (CreateXxxDto/UpdateXxxDto) have no string index
                // signature, and a type without one is NOT assignable to Record<string, unknown>
                // under TypeScript's structural typing - so callers passing a concrete DTO would
                // fail to type-check against that constraint. "data" is where the index signature
                // actually lives, as an explicit local annotation, which is what allows the
                // dynamic "data.<field> = ..." assignments below without touching T itself.
                private toPrismaCreateData<T extends object>(dto: T): T {
                    // "as unknown as Record<string, unknown>": a plain "as Record<string, unknown>"
                    // is rejected by TS here too - spreading a generic T keeps T's own (index-
                    // signature-less) shape, and neither direction of that assertion is considered
                    // a "sufficient overlap" on its own. Going through unknown first is the
                    // standard, always-legal escape hatch for exactly this situation.
                    const data = { ...dto } as unknown as Record<string, unknown>;
                    ${dateLines}
                    ${m2mCreateLines}
                    return data as T;
                }

                private toPrismaUpdateData<T extends object>(dto: T): T {
                    const data = { ...dto } as unknown as Record<string, unknown>;
                    ${dateLines}
                    ${m2mUpdateLines}
                    return data as T;
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
                ? `,\n    include: { ${directRelations.map((r) => `${r.fieldName}: true`).join(', ')} }`
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
                    if (!record) throw new NotFoundException('${modelName} not found.');
                    return record;
                }

                async update(id: string, dto: Update${modelName}Dto) {
                    await this.findOne(id);
                    return this.prisma.${modelCamel}.update({ where: { id }, data: ${updateData} as any${includeClause} });
                }

                async remove(id: string) {
                    await this.findOne(id);
                    await this.prisma.${modelCamel}.delete({ where: { id } });
                    return { message: '${modelName} deleted.' };
                }
                
            }
        `;
    }

    /**
     * Generates source code for the entity controller (REST endpoints, route guards, Swagger tags).
     */
    private buildController(
        modelName: string,
        tableName: string,
        isSchedulable: boolean,
        authFlags: { create: boolean; read: boolean; update: boolean; delete: boolean },
    ): string {

        const anyProtected = authFlags.create || authFlags.read || authFlags.update || authFlags.delete;
        const guardImport = anyProtected
            ? `\nimport { UseGuards } from '@nestjs/common';\nimport { JwtAuthGuard } from '../common/guards/jwt-auth.guard';`
            : '';
        const guardDecorator = (protect: boolean) => (protect ? '  @UseGuards(JwtAuthGuard)\n' : '');

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
            import { ApiTags${anyProtected ? ', ApiBearerAuth' : ''} } from '@nestjs/swagger';${guardImport}
            import { ${modelName}Service } from './${tableName}.service';
            import { Create${modelName}Dto } from './dto/create-${tableName}.dto';
            import { Update${modelName}Dto } from './dto/update-${tableName}.dto';

            @ApiTags('${modelName}')
            ${anyProtected ? `@ApiBearerAuth('access-token')\n` : ''}@Controller('${tableName}')
            export class ${modelName}Controller {

                constructor(private readonly service: ${modelName}Service) {}

                ${guardDecorator(authFlags.create)}  @Post()
                create(@Body() dto: Create${modelName}Dto) {
                    return this.service.create(dto);
                }

                ${guardDecorator(authFlags.read)} ${findAllSignature}

                ${guardDecorator(authFlags.read)} @Get(':id')
                findOne(@Param('id') id: string) {
                    return this.service.findOne(id);
                }

                ${guardDecorator(authFlags.update)}  @Patch(':id')
                update(@Param('id') id: string, @Body() dto: Update${modelName}Dto) {
                    return this.service.update(id, dto);
                }

                ${guardDecorator(authFlags.delete)}  @Delete(':id')
                remove(@Param('id') id: string) {
                    return this.service.remove(id);
                }
            }
        `;
    }

    /**
     * Generates source code for the target entity NestJS `@Module`.
     */
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