import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchemaBuilderService } from './schema-builder.service';
import { PrismaService } from '../prisma/prisma.service';
import { toPascalCase, toCamelCase } from '../common/utils/case.util';
import { FIELD_TYPE_VALIDATORS } from '../common/utils/field-type-validator-mapper.util';
import { computeRelationFieldsByEntity, RelationFieldMeta } from '../common/utils/relation-metadata.util';

/**
 * Describes a single field of a request or response body shape in the manifest output.
 */
interface ManifestFieldShape {
    name: string;
    type: string;
    required: boolean;
}

/**
 * Describes a single HTTP endpoint exposed by a generated backend for one entity.
 */
interface ManifestEndpoint {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    requiresAuth: boolean;
    description: string;
    requestBody: ManifestFieldShape[] | null;
    responseBody: ManifestFieldShape[] | 'array' | null;
}

/**
 * Describes every generated endpoint for a single entity (database table).
 */
export interface ManifestResource {
    entity: string;
    tableName: string;
    basePath: string;
    endpoints: ManifestEndpoint[];
}

/**
 * Describes the complete machine-readable API manifest generated for a platform.
 * Contains the platform identity, public gateway base URL, generation timestamp,
 * total number of resources, and the complete list of generated API resources.
 *
 * Educational Note: this explicit public contract allows controllers and other
 * modules to consume the manifest without relying on an inferred return type,
 * keeping the API manifest structure stable, discoverable, and type-safe.
 */
export interface ApiManifest {
    platform: {
        id: string;
        slug: string;
    };
    publicBaseUrl: string;
    generatedAt: string;
    resourceCount: number;
    resources: ManifestResource[];
}

/**
 * NestJS Service computing a machine-readable "API manifest" for a platform's generated
 * backend: every REST route `CrudGeneratorService` would produce for its active entities,
 * together with the shape of the data each route expects (request body) and returns
 * (response body).
 *
 * Educational Note: this deliberately mirrors the code-generation logic in
 * `CrudGeneratorService` and `SchemaBuilderService` (same field-type mapping, same relation
 * computation, same route naming) WITHOUT touching the filesystem or requiring the backend to
 * have been generated/started - it reads the same Entity/Field/Relation source-of-truth
 * records directly from the database, so the manifest is always in sync with what the next
 * generation would actually produce.
 */
@Injectable()
export class ApiManifestService {

    constructor(
        private readonly prisma: PrismaService,
        private readonly schemaBuilder: SchemaBuilderService,
        private readonly configService: ConfigService,
    ) {}

    /**
     * Builds the full API manifest for a given platform.
     */
    async buildManifest(platform: { id: string; slug: string }): Promise<ApiManifest> {

        const entities = await this.schemaBuilder.getActiveEntitiesWithFields(platform.id);
        const relations = await this.prisma.relation.findMany({ where: { platformId: platform.id } });

        const relationFieldsByEntity = computeRelationFieldsByEntity(
            entities.map((entity) => ({ id: entity.id, tableName: entity.tableName })),
            relations,
        );

        const gatewayPrefix = this.configService.get<string>('GENERATED_BACKEND_GATEWAY_PREFIX', '/generated');

        const resources: ManifestResource[] = entities.map((entity) =>
            this.buildResource(entity, relationFieldsByEntity.get(entity.id) ?? []),
        );

        return {
            platform: { id: platform.id, slug: platform.slug },
            // Public entry point once the platform is generated AND running - see
            // `src/gateway/GATEWAY_README.md`. Direct-to-process access is intentionally never
            // exposed here, only the public gateway path.
            publicBaseUrl: `${gatewayPrefix}/${platform.slug}/api`,
            generatedAt: new Date().toISOString(),
            resourceCount: resources.length,
            resources,
        };
    }

    /**
     * Builds the manifest entry (all 5 standard CRUD endpoints) for a single entity.
     */
    private buildResource(
        entity: {
            tableName: string;
            isSchedulable: boolean;
            authProtectCreate: boolean;
            authProtectRead: boolean;
            authProtectUpdate: boolean;
            authProtectDelete: boolean;
            fields: { column: string; type: string; required: boolean }[];
        },
        relations: RelationFieldMeta[],
    ): ManifestResource {

        const modelName = toPascalCase(entity.tableName);
        const basePath = `/${entity.tableName}`;

        const writableFields = this.buildFieldShapes(entity.fields, relations, entity.isSchedulable);
        const responseFields = this.buildResponseShapes(entity.fields, relations, entity.isSchedulable);

        const endpoints: ManifestEndpoint[] = [
            {
                method: 'POST',
                path: basePath,
                requiresAuth: entity.authProtectCreate,
                description: `Create a new ${modelName}.`,
                requestBody: writableFields.map((f) => ({ ...f, required: f.required })),
                responseBody: responseFields,
            },
            {
                method: 'GET',
                path: basePath,
                requiresAuth: entity.authProtectRead,
                description: entity.isSchedulable
                    ? `List ${modelName} records (published only by default; pass ?includeUnpublished=true to see everything).`
                    : `List all ${modelName} records.`,
                requestBody: null,
                responseBody: 'array',
            },
            {
                method: 'GET',
                path: `${basePath}/:id`,
                requiresAuth: entity.authProtectRead,
                description: `Retrieve a single ${modelName} by ID.`,
                requestBody: null,
                responseBody: responseFields,
            },
            {
                method: 'PATCH',
                path: `${basePath}/:id`,
                requiresAuth: entity.authProtectUpdate,
                description: `Partially update a ${modelName}. All fields are optional on this route.`,
                requestBody: writableFields.map((f) => ({ ...f, required: false })),
                responseBody: responseFields,
            },
            {
                method: 'DELETE',
                path: `${basePath}/:id`,
                requiresAuth: entity.authProtectDelete,
                description: `Delete a ${modelName}.`,
                requestBody: null,
                responseBody: null,
            },
        ];

        return { entity: modelName, tableName: entity.tableName, basePath, endpoints };
    }

    /**
     * Builds the writable field shape list (used for the create/update request bodies):
     * regular business fields, relation foreign keys, and schedulable publish/unpublish dates.
     * Mirrors `CrudGeneratorService.buildDtoFields()` / `buildRelationDtoFields()`.
     */
    private buildFieldShapes(
        fields: { column: string; type: string; required: boolean }[],
        relations: RelationFieldMeta[],
        isSchedulable: boolean,
    ): ManifestFieldShape[] {

        const shapes: ManifestFieldShape[] = fields.map((field) => ({
            name: toCamelCase(field.column),
            type: FIELD_TYPE_VALIDATORS[field.type as keyof typeof FIELD_TYPE_VALIDATORS].tsType,
            required: field.required,
        }));

        for (const relation of relations) {
            if (relation.hasScalarFk) {
                shapes.push({ name: `${relation.fieldName}Id`, type: 'string (UUID)', required: false });
            } else if (relation.isManyToMany) {
                shapes.push({ name: `${relation.fieldName}Ids`, type: 'string (UUID)[]', required: false });
            }
        }

        if (isSchedulable) {
            shapes.push({ name: 'publishAt', type: 'string (ISO date)', required: false });
            shapes.push({ name: 'unpublishAt', type: 'string (ISO date)', required: false });
        }

        return shapes;
    }

    /**
     * Builds the response field shape list: everything a created/fetched record contains,
     * i.e. the writable fields above PLUS the fields Prisma always adds itself
     * (`id`, `createdAt`, `updatedAt`) PLUS any directly-included relation objects/arrays
     * (mirrors the `include: { ... }` clause `CrudGeneratorService.buildService()` adds for
     * every direct - non many-to-many - relation).
     */
    private buildResponseShapes(
        fields: { column: string; type: string; required: boolean }[],
        relations: RelationFieldMeta[],
        isSchedulable: boolean,
    ): ManifestFieldShape[] {

        const shapes: ManifestFieldShape[] = [
            { name: 'id', type: 'string (UUID)', required: true },
            ...this.buildFieldShapes(fields, [], isSchedulable),
        ];

        for (const relation of relations) {
            if (relation.isManyToMany) {
                shapes.push({ name: relation.fieldName, type: `${relation.targetModelName}[]`, required: false });
            } else if (relation.hasScalarFk) {
                shapes.push({ name: `${relation.fieldName}Id`, type: 'string (UUID)', required: false });
                shapes.push({ name: relation.fieldName, type: relation.targetModelName, required: false });
            } else {
                shapes.push({
                    name: relation.fieldName,
                    type: relation.isList ? `${relation.targetModelName}[]` : relation.targetModelName,
                    required: false,
                });
            }
        }

        shapes.push({ name: 'createdAt', type: 'string (ISO date)', required: true });
        shapes.push({ name: 'updatedAt', type: 'string (ISO date)', required: true });

        return shapes;
    }
}
