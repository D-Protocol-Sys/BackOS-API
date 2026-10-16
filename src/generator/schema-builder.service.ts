import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FIELD_TYPE_TO_PRISMA } from '../common/utils/field-type-mapper.util';
import { toPascalCase, toCamelCase } from '../common/utils/case.util';
import { buildRelationLinesByEntity } from '../common/utils/relation-schema-builder.util';
import { toEnumPrismaName } from '../common/utils/enum-value.util';

@Injectable()
export class SchemaBuilderService {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * Fetches all non-archived entities and their corresponding non-archived fields.
     */
    async getActiveEntitiesWithFields(platformId: string) {
        return this.prisma.entity.findMany({
            where: { platformId, isArchived: false },
            include: {
                fields: {
                    where: { isArchived: false },
                    orderBy: { order: 'asc' },
                    // An ENUM field's own allowed values, needed by SchemaBuilderService (which Prisma
                    // `enum` type it resolves to), CrudGeneratorService and the "Auth & User" generator
                    // (the `@IsIn([...])` validator and TS union type - see `buildDtoFieldsSource`).
                    include: { enumDefinition: true },
                },
            },
            orderBy: { createdAt: 'asc' },
        });
    }

    /**
     * Dynamically builds a complete Prisma schema string for a specific platform.
     * Educational Note: We programmatically reconstruct data models, fields, and relations
     * to enable multi-tenant dynamic schema generation at runtime.
     */
    async buildSchema(platformId: string, extraPrismaBlocks: string[] = []): Promise<string> {
        const entities = await this.getActiveEntitiesWithFields(platformId);

        if (entities.length === 0) {
            throw new BadRequestException(
                'This platform contains no active entities. Add at least one table before generating the schema.',
            );
        }

        // Every EnumDefinition actually referenced by an active ENUM field becomes a genuine
        // Prisma `enum` block, emitted once (Prisma enums are schema-global, not per-model) even
        // when several fields - possibly on different entities - share the same one.
        const usedEnumIds = new Set(
            entities.flatMap((entity) =>
                entity.fields
                    .filter((f) => f.type === 'ENUM' && f.enumDefinitionId)
                    .map((f) => f.enumDefinitionId as string),
            ),
        );
        const enumDefinitions =
            usedEnumIds.size > 0
                ? await this.prisma.enumDefinition.findMany({ where: { id: { in: Array.from(usedEnumIds) } } })
                : [];
        const enumPrismaNameById = new Map(enumDefinitions.map((e) => [e.id, toEnumPrismaName(e.name)]));
        const enumBlocks = enumDefinitions
            .map((e) => `enum ${enumPrismaNameById.get(e.id)} {\n${e.values.map((v) => `  ${v}`).join('\n')}\n}`)
            .join('\n\n');

        const relations = await this.prisma.relation.findMany({ where: { platformId } });
        const relationLinesByEntity = buildRelationLinesByEntity(
            entities.map((e) => ({ id: e.id, tableName: e.tableName })),
            relations,
        );

        const header = [
            'generator client {',
            '  provider     = "prisma-client"',
            '  output       = "./generated/prisma"',
            '  engineType   = "client"',
            '  moduleFormat = "cjs"',
            '}',
            '',
            'datasource db {',
            '  provider = "postgresql"',
            '}',
        ].join('\n');

        const models = entities
            .map((entity) => this.buildModel(entity, relationLinesByEntity.get(entity.id) ?? [], enumPrismaNameById))
            .join('\n\n');

        const extra = extraPrismaBlocks.join('\n');
        const enumSection = enumBlocks ? `${enumBlocks}\n\n` : '';

        return `${header}\n\n${enumSection}${models}\n${extra}\n`;
    }

    /**
     * Constructs a single Prisma model block from entity metadata.
     */
    private buildModel(
        entity: {
            tableName: string;
            isSchedulable: boolean;
            fields: {
                column: string;
                type: string;
                required: boolean;
                unique: boolean;
                isArray: boolean;
                defaultValue: string | null;
                enumDefinitionId?: string | null;
            }[];
        },
        relationLines: string[],
        enumPrismaNameById: Map<string, string>,
    ): string {
        const modelName = toPascalCase(entity.tableName);
        const fieldLines = entity.fields.map((field) => this.buildFieldLine(field, enumPrismaNameById));
        const schedulableLines = entity.isSchedulable ? ['  publishAt DateTime?', '  unpublishAt DateTime?'] : [];

        const lines = [
            `model ${modelName} {`,
            '  id String @id @default(uuid())',
            ...fieldLines,
            ...relationLines,
            ...schedulableLines,
            '  createdAt DateTime @default(now())',
            '  updatedAt DateTime @updatedAt',
            '',
            `  @@map("${entity.tableName}")`,
            '}',
        ];

        return lines.join('\n');
    }

    /**
     * Maps field attributes to a single line in the Prisma schema definition.
     */
    private buildFieldLine(
        field: {
            column: string;
            type: string;
            required: boolean;
            unique: boolean;
            isArray: boolean;
            defaultValue: string | null;
            enumDefinitionId?: string | null;
        },
        enumPrismaNameById: Map<string, string>,
    ): string {
        const fieldName = toCamelCase(field.column);
        // An ENUM field's Prisma type is its OWN EnumDefinition's generated `enum` name, not a
        // fixed mapping from FieldType - FieldsService guarantees enumDefinitionId is always set
        // (and valid) on a field of this type, so the lookup below cannot miss.
        const prismaType =
            field.type === 'ENUM'
                ? (enumPrismaNameById.get(field.enumDefinitionId as string) as string)
                : FIELD_TYPE_TO_PRISMA[field.type as keyof typeof FIELD_TYPE_TO_PRISMA];

        // ARRAY fields (tags, image/video galleries, ...) become a native PostgreSQL array
        // column (`TEXT[]`, `DOUBLE PRECISION[]`, `JSONB[]`, ...). Prisma rules that shape this line:
        //   - a scalar list can never be optional (`String[]?` is invalid) - so no `?` here, and
        //     "required" is enforced at the API layer instead (`@ArrayNotEmpty()` in the DTO);
        //   - `@default([])` makes an omitted value an empty list instead of NULL;
        //   - `@unique` on a list is not supported, and neither is a custom default - both are
        //     rejected up front by `FieldsService`, so they can never reach this point.
        if (field.isArray) {
            return `  ${fieldName} ${prismaType}[] @default([])`;
        }

        const optionalMark = field.required ? '' : '?';

        const attributes: string[] = [];
        if (field.unique) attributes.push('@unique');

        const defaultAttr = this.buildDefaultAttribute(field.type, field.defaultValue);
        if (defaultAttr) attributes.push(defaultAttr);

        const attrString = attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
        return `  ${fieldName} ${prismaType}${optionalMark}${attrString}`;
    }

    /**
     * Parses and escapes raw user-defined default values into valid Prisma field decorators.
     * Educational Note: String inputs are escaped to prevent accidental syntax injection
     * when injecting values directly into the schema.
     */
    private buildDefaultAttribute(type: string, rawDefault: string | null): string | null {
        if (rawDefault === null || rawDefault === undefined || rawDefault === '') return null;

        switch (type) {
            case 'STRING':
            case 'TEXT':
            case 'IMAGE':
            case 'FILE':
            case 'VIDEO':
            case 'MEDIA':
            case 'URL': {
                const escaped = rawDefault.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                return `@default("${escaped}")`;
            }
            case 'NUMBER': {
                const num = Number(rawDefault);
                return Number.isFinite(num) ? `@default(${num})` : null;
            }
            case 'BOOLEAN': {
                if (rawDefault === 'true') return '@default(true)';
                if (rawDefault === 'false') return '@default(false)';
                return null;
            }
            default:
                return null;
        }
    }
}
