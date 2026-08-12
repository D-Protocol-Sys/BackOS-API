import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FIELD_TYPE_TO_PRISMA } from '../common/utils/field-type-mapper.util';
import { toPascalCase, toCamelCase } from '../common/utils/case.util';
import { buildRelationLinesByEntity } from '../common/utils/relation-schema-builder.util';

@Injectable()
export class SchemaBuilderService {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * Fetches all non-archived entities and their corresponding non-archived fields.
     */
    async getActiveEntitiesWithFields(platformId: string) {
        return this.prisma.entity.findMany({
            where: { platformId, isArchived: false },
            include: { fields: { where: { isArchived: false }, orderBy: { order: 'asc' } } },
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
            .map((entity) => this.buildModel(entity, relationLinesByEntity.get(entity.id) ?? []))
            .join('\n\n');

        const extra = extraPrismaBlocks.join('\n');

        return `${header}\n\n${models}\n${extra}\n`;
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
                defaultValue: string | null;
            }[];
        },
        relationLines: string[],
    ): string {
        const modelName = toPascalCase(entity.tableName);
        const fieldLines = entity.fields.map((field) => this.buildFieldLine(field));
        const schedulableLines = entity.isSchedulable
            ? ['  publishAt DateTime?', '  unpublishAt DateTime?']
            : [];

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
    private buildFieldLine(field: {
        column: string;
        type: string;
        required: boolean;
        unique: boolean;
        defaultValue: string | null;
    }): string {
        const fieldName = toCamelCase(field.column);
        const prismaType = FIELD_TYPE_TO_PRISMA[field.type as keyof typeof FIELD_TYPE_TO_PRISMA];
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