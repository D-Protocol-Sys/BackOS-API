import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { toPascalCase, toCamelCase } from '../common/utils/case.util';
import { FIELD_TYPE_VALIDATORS } from '../common/utils/field-type-validator-mapper.util';
import { buildDtoFieldsSource, collectFieldValidatorImports } from '../common/utils/dto-field-builder.util';
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
    fields: {
        column: string;
        type: string;
        required: boolean;
        isArray: boolean;
        enumDefinition?: { values: string[] } | null;
    }[];
}

/** Flattens each field's `enumDefinition.values` into the `enumValues` shape `buildDtoFieldsSource()` expects. */
function withEnumValues(fields: EntityWithFields['fields']) {
    return fields.map((field) => ({ ...field, enumValues: field.enumDefinition?.values }));
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
     * Handles both scalar fields and ARRAY fields (`Field.isArray`) - see `buildDtoFieldsSource()`.
     */
    private buildDtoFields(fields: EntityWithFields['fields'], forceOptional: boolean): string {
        return buildDtoFieldsSource(withEnumValues(fields), forceOptional);
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
        const set = collectFieldValidatorImports(withEnumValues(fields));
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
            isSchedulable ? this.schedulableDtoFields() : '',
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
        isSchedulable: boolean,
    ): string {
        const imports = new Set(this.collectImports(fields, relations).split(', '));
        if (isSchedulable) imports.add('IsDateString');
        const body = [
            this.buildDtoFields(fields, true),
            this.buildRelationDtoFields(relations, true),
            isSchedulable ? this.schedulableDtoFields() : '',
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
        isSchedulable: boolean,
    ): string {
        const modelCamel = toCamelCase(tableName);
        const dateFields = fields.filter(
            (f) => FIELD_TYPE_VALIDATORS[f.type as keyof typeof FIELD_TYPE_VALIDATORS].isDateField,
        );
        const arrayFields = fields.filter((f) => f.isArray);

        const m2mRelations = relations.filter((r) => r.isManyToMany);
        const directRelations = relations.filter((r) => r.hasScalarFk || r.isList);

        const needsTransform = dateFields.length > 0 || m2mRelations.length > 0 || arrayFields.length > 0;

        // ARRAY fields: Prisma scalar lists can never be `null` (there is no `String[]?`), but the
        // DTO's `@IsOptional()` lets an explicit `null` through validation - so a client sending
        // `{ "tags": null }` to mean "clear it" would otherwise crash Prisma with a 500. For an
        // OPTIONAL array that is normalised to an empty list; for a REQUIRED one (which must never
        // be emptied) the null is simply ignored, leaving the stored value untouched.
        const arrayNullLines = arrayFields
            .map((f) => {
                const name = toCamelCase(f.column);
                return f.required
                    ? `    if (data.${name} === null) delete data.${name};`
                    : `    if (data.${name} === null) data.${name} = [];`;
            })
            .join('\n');

        // DATE fields: an ISO string from the client becomes a Date. `null` is deliberately left
        // alone (it means "clear this optional column") - `new Date(null)` would silently store
        // 1970-01-01 instead. For ARRAY date fields every element is converted.
        const dateLines = dateFields
            .map((f) => {
                const name = toCamelCase(f.column);
                if (f.isArray) {
                    return `    if (Array.isArray(data.${name})) data.${name} = (data.${name} as string[]).map((value) => new Date(value)) as any;`;
                }
                return `    if (data.${name} !== undefined && data.${name} !== null) data.${name} = new Date(data.${name} as string) as any;`;
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
                    ${arrayNullLines}
                    ${dateLines}
                    ${m2mCreateLines}
                    return data as T;
                }

                private toPrismaUpdateData<T extends object>(dto: T): T {
                    const data = { ...dto } as unknown as Record<string, unknown>;
                    ${arrayNullLines}
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

        // `includeUnpublished` defaults to true because update() / remove() call findOne() to check
        // that a record exists - they must reach unpublished ones too. The HTTP GET route passes false
        // unless an internal account explicitly asked otherwise (see the controller).
        const findOneMethod = isSchedulable
            ? `async findOne(id: string, includeUnpublished = true) {
                    const record = await this.prisma.${modelCamel}.findUnique({ where: { id }${includeClause} });
                    if (!record) throw new NotFoundException('${modelName} not found.');
                    if (!includeUnpublished) {
                        const now = new Date();
                        const { publishAt, unpublishAt } = record as { publishAt?: Date | null; unpublishAt?: Date | null };
                        const isPublished = (!publishAt || publishAt <= now) && (!unpublishAt || unpublishAt > now);
                        // Same answer as a record that does not exist: a visitor learns nothing.
                        if (!isPublished) throw new NotFoundException('${modelName} not found.');
                    }
                    return record;
                }`
            : `async findOne(id: string) {
                    const record = await this.prisma.${modelCamel}.findUnique({ where: { id }${includeClause} });
                    if (!record) throw new NotFoundException('${modelName} not found.');
                    return record;
                }`;

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

                ${findOneMethod}

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
        const anyWriteProtected = authFlags.create || authFlags.update || authFlags.delete;
        // A SCHEDULABLE entity (availability window: publishAt / unpublishAt) also guards its read
        // routes with UnpublishedAccessGuard - see below. The Scheduler service, which is what makes an
        // entity schedulable, requires Auth & User, so that guard file always exists in that case.
        const needsGuards = anyProtected || isSchedulable;
        const guardImport = needsGuards
            ? `\nimport { UseGuards } from '@nestjs/common';${
                  anyProtected ? `\nimport { JwtAuthGuard } from '../common/guards/jwt-auth.guard';` : ''
              }${anyWriteProtected ? `\nimport { InternalOnlyGuard } from '../common/guards/internal-only.guard';` : ''}${
                  isSchedulable
                      ? `\nimport { UnpublishedAccessGuard } from '../common/guards/unpublished-access.guard';`
                      : ''
              }`
            : '';
        // READ routes: any signed-in account (internal staff, or an external visitor / customer).
        // WRITE routes (create / update / delete): INTERNAL accounts only - an external user is a
        // visitor and never holds administration rights, whatever the entity.
        const guardDecorator = (protect: boolean, writes = false) =>
            protect
                ? writes
                    ? '  @UseGuards(JwtAuthGuard, InternalOnlyGuard)\n'
                    : '  @UseGuards(JwtAuthGuard)\n'
                : '';

        // READ routes of a schedulable entity: whoever is allowed to read the entity only ever sees
        // PUBLISHED records, unless they ask for `?includeUnpublished=true` AND hold an internal
        // token (UnpublishedAccessGuard: 401 without a token, 403 for an external user).
        const readGuards = isSchedulable
            ? authFlags.read
                ? '  @UseGuards(JwtAuthGuard, UnpublishedAccessGuard)\n'
                : '  @UseGuards(UnpublishedAccessGuard)\n'
            : guardDecorator(authFlags.read);

        const findAllSignature = isSchedulable
            ? ` @Get()
                findAll(@Query('includeUnpublished') includeUnpublished?: string) {
                    return this.service.findAll(includeUnpublished === 'true');
                }`
            : ` @Get()
                findAll() {
                    return this.service.findAll();
                }`;

        const findOneSignature = isSchedulable
            ? `@Get(':id')
                findOne(@Param('id') id: string, @Query('includeUnpublished') includeUnpublished?: string) {
                    return this.service.findOne(id, includeUnpublished === 'true');
                }`
            : `@Get(':id')
                findOne(@Param('id') id: string) {
                    return this.service.findOne(id);
                }`;

        const queryImport = isSchedulable ? ', Query' : '';

        return `
            import { Body, Controller, Delete, Get, Param, Patch, Post${queryImport} } from '@nestjs/common';
            import { ApiTags${needsGuards ? ', ApiBearerAuth' : ''} } from '@nestjs/swagger';${guardImport}
            import { ${modelName}Service } from './${tableName}.service';
            import { Create${modelName}Dto } from './dto/create-${tableName}.dto';
            import { Update${modelName}Dto } from './dto/update-${tableName}.dto';

            @ApiTags('${modelName}')
            ${needsGuards ? `@ApiBearerAuth('access-token')\n` : ''}@Controller('${tableName}')
            export class ${modelName}Controller {

                constructor(private readonly service: ${modelName}Service) {}

                ${guardDecorator(authFlags.create, true)}  @Post()
                create(@Body() dto: Create${modelName}Dto) {
                    return this.service.create(dto);
                }

                ${readGuards} ${findAllSignature}

                ${readGuards} ${findOneSignature}

                ${guardDecorator(authFlags.update, true)}  @Patch(':id')
                update(@Param('id') id: string, @Body() dto: Update${modelName}Dto) {
                    return this.service.update(id, dto);
                }

                ${guardDecorator(authFlags.delete, true)}  @Delete(':id')
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
