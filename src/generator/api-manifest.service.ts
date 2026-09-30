import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchemaBuilderService } from './schema-builder.service';
import { PrismaService } from '../prisma/prisma.service';
import { toPascalCase, toCamelCase } from '../common/utils/case.util';
import { tsTypeFor } from '../common/utils/field-type-validator-mapper.util';
import { UPLOAD_FIELD_TYPES } from '../common/utils/field-type-mapper.util';
import { computeRelationFieldsByEntity, RelationFieldMeta } from '../common/utils/relation-metadata.util';

/**
 * Describes a single field of a request or response body shape in the manifest output.
 */
interface ManifestFieldShape {
    name: string;
    type: string;
    required: boolean;
    /**
     * Set to `true` on a field holding a file reference (IMAGE / VIDEO / MEDIA / FILE): the value
     * is the URL returned by `POST /uploads`, so a frontend should render an upload widget, upload
     * each file first, then send the resulting URL(s) here. Absent on every other field.
     */
    upload?: boolean;
    /** On an ENUM field: the exact allowed values (in order), the same ones `@IsIn()` validates against. */
    enumValues?: string[];
}

/**
 * Describes a single HTTP endpoint exposed by a generated backend for one entity.
 */
interface ManifestEndpoint {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    /** True whenever a token is needed (`access` is then 'authenticated' or 'internal'). */
    requiresAuth: boolean;
    /**
     * Who may call the route on the generated backend:
     *  - 'public'        : anyone;
     *  - 'authenticated' : any signed-in account (internal staff OR an external visitor / customer);
     *  - 'internal'      : internal accounts only (BackOS username + authenticator code) - the rule for
     *                      every create / update / delete on a protected entity.
     */
    access: 'public' | 'authenticated' | 'internal';
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

/** `'DRAFT' | 'ACTIVE'`, or `('DRAFT' | 'ACTIVE')[]` for an array ENUM field. Mirrors dto-field-builder.util.ts. */
function enumUnionType(values: string[], isArray: boolean): string {
    const union = values.length > 0 ? values.map((v) => `'${v}'`).join(' | ') : 'string';
    return isArray ? `(${union})[]` : union;
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
            // `src/gateway/GATEWAY_README.md`. NOTE: no trailing `/api` segment - the gateway
            // proxy (`generated-backend-proxy.middleware.ts`) rewrites `/generated/<slug>/...`
            // straight to the generated backend's own routes (e.g.
            // `/generated/portfolio/getprojects`, never `/generated/portfolio/api/...`); `/api`
            // was never part of the real public path and following it as written would 404.
            publicBaseUrl: `${gatewayPrefix}/${platform.slug}`,
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
            fields: { column: string; type: string; required: boolean; isArray: boolean; enumDefinition?: { values: string[] } | null }[];
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
                // Writes are administrative: an external user (a visitor) can never perform them.
                access: entity.authProtectCreate ? 'internal' : 'public',
                description: `Create a new ${modelName}.${entity.authProtectCreate ? ' Internal accounts only.' : ''}`,
                requestBody: writableFields.map((f) => ({ ...f, required: f.required })),
                responseBody: responseFields,
            },
            {
                method: 'GET',
                path: basePath,
                requiresAuth: entity.authProtectRead,
                access: entity.authProtectRead ? 'authenticated' : 'public',
                description: entity.isSchedulable
                    ? `List ${modelName} records (published ones only). Pass ?includeUnpublished=true to see everything - that requires an internal account (401 without a token, 403 for an external user).`
                    : `List all ${modelName} records.`,
                requestBody: null,
                responseBody: 'array',
            },
            {
                method: 'GET',
                path: `${basePath}/:id`,
                requiresAuth: entity.authProtectRead,
                access: entity.authProtectRead ? 'authenticated' : 'public',
                description: entity.isSchedulable
                    ? `Retrieve a single ${modelName} by ID. An unpublished record answers 404 unless ?includeUnpublished=true is passed with an internal account's token.`
                    : `Retrieve a single ${modelName} by ID.`,
                requestBody: null,
                responseBody: responseFields,
            },
            {
                method: 'PATCH',
                path: `${basePath}/:id`,
                requiresAuth: entity.authProtectUpdate,
                access: entity.authProtectUpdate ? 'internal' : 'public',
                description: `Partially update a ${modelName}. All fields are optional on this route.${entity.authProtectUpdate ? ' Internal accounts only.' : ''}`,
                requestBody: writableFields.map((f) => ({ ...f, required: false })),
                responseBody: responseFields,
            },
            {
                method: 'DELETE',
                path: `${basePath}/:id`,
                requiresAuth: entity.authProtectDelete,
                access: entity.authProtectDelete ? 'internal' : 'public',
                description: `Delete a ${modelName}.${entity.authProtectDelete ? ' Internal accounts only.' : ''}`,
                requestBody: null,
                // CrudGeneratorService's remove() returns `{ message: '<Model> deleted.' }`,
                // not an empty body - see buildService() in crud-generator.service.ts.
                responseBody: [{ name: 'message', type: 'string', required: true }],
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
        fields: {
            column: string;
            type: string;
            required: boolean;
            isArray: boolean;
            enumDefinition?: { values: string[] } | null;
        }[],
        relations: RelationFieldMeta[],
        isSchedulable: boolean,
    ): ManifestFieldShape[] {

        const shapes: ManifestFieldShape[] = fields.map((field) => ({
            name: toCamelCase(field.column),
            // ENUM: a quoted string-literal union of its own values (mirrors buildDtoFieldsSource());
            // every other type: `string[]` for an array field, `string` (or similar) otherwise.
            type:
                field.type === 'ENUM'
                    ? enumUnionType(field.enumDefinition?.values ?? [], field.isArray)
                    : tsTypeFor(field.type, field.isArray),
            required: field.required,
            ...(UPLOAD_FIELD_TYPES.has(field.type) ? { upload: true } : {}),
            ...(field.type === 'ENUM' ? { enumValues: field.enumDefinition?.values ?? [] } : {}),
        }));

        for (const relation of relations) {
            if (relation.hasScalarFk) {
                // Always required, matching CrudGeneratorService.buildRelationDtoFields():
                // `isOptional = forceOptional`, and forceOptional is `false` for the create
                // path - so the real CreateXxxDto never marks a scalar FK as optional,
                // regardless of whether the underlying relation itself is nullable. (The
                // PATCH endpoint below still forces every writable field to `required: false`
                // on top of this, which is correct - buildRelationDtoFields does the same for
                // updates via its own `forceOptional` there.)
                shapes.push({ name: `${relation.fieldName}Id`, type: 'string (UUID)', required: true });
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
        fields: { column: string; type: string; required: boolean; isArray: boolean; enumDefinition?: { values: string[] } | null }[],
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
            } else if (relation.isList) {
                // The "one" side of a one-to-many relation: no scalar FK on this side, but
                // still a real array field in the response, because CrudGeneratorService's
                // `directRelations = relations.filter(r => r.hasScalarFk || r.isList)` picks
                // it up for the Prisma `include` clause via `isList`, same as the M2M branch
                // above.
                shapes.push({ name: relation.fieldName, type: `${relation.targetModelName}[]`, required: false });
            }
            // else: the "virtual"/non-owning side of a one-to-one relation
            // (hasScalarFk: false, isList: false, isManyToMany: false). Deliberately NOT added
            // here - it fails that same `hasScalarFk || isList` test, so the real generated
            // backend's Prisma `include` clause never fetches it and this field will always be
            // absent from the actual JSON response. Listing it here would document a field
            // that never actually shows up.
        }

        shapes.push({ name: 'createdAt', type: 'string (ISO date)', required: true });
        shapes.push({ name: 'updatedAt', type: 'string (ISO date)', required: true });

        return shapes;
    }
}
