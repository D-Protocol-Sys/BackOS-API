import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FIELD_TYPE_TO_PRISMA } from '../common/utils/field-type-mapper.util';
import { toPascalCase, toCamelCase } from '../common/utils/case.util';

@Injectable()
export class SchemaBuilderService {

    constructor(private readonly prisma: PrismaService) {}

    async getActiveEntitiesWithFields(platformId: string) {
        return this.prisma.entity.findMany({
            where: { platformId, isArchived: false },
            include: { fields: { where: { isArchived: false }, orderBy: { order: 'asc' } } },
            orderBy: { createdAt: 'asc' },
        });
    }

    async buildSchema(platformId: string): Promise<string> {

        const entities = await this.getActiveEntitiesWithFields(platformId);

        if (entities.length === 0) {
            throw new BadRequestException(
                'Cette plateforme ne contient aucune entité active. Ajoute au moins une table avant de générer.',
            );
        }

        const header = `
            generator client {
                provider     = "prisma-client"
                output       = "./generated/prisma"
                engineType   = "client"
                moduleFormat = "cjs"
            }

            datasource db {
                provider = "postgresql"
            }
        `;

        const models = entities.map((entity) => this.buildModel(entity)).join('\n\n');

        return `${header}\n${models}\n`;
    }

    private buildModel(entity: {
        tableName: string;
        fields: {
            column: string;
            type: string;
            required: boolean;
            unique: boolean;
            defaultValue: string | null;
        }[];
    }): string {

        const modelName = toPascalCase(entity.tableName);

        const fieldLines = entity.fields.map((field) => this.buildFieldLine(field));

        const lines = [
            `model ${modelName} {`,
            `  id String @id @default(uuid())`,
            ...fieldLines,
            `  createdAt DateTime @default(now())`,
            `  updatedAt DateTime @updatedAt`,
            ``,
            `  @@map("${entity.tableName}")`,
            `}`,
        ];

        return lines.join('\n');

    }

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
