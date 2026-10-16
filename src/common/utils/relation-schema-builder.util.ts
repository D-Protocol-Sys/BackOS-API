import { computeRelationFieldsByEntity, RelationRow, EntityRef, RelationFieldMeta } from './relation-metadata.util';

/**
 * Generates formatted Prisma schema relation DSL lines grouped by entity ID.
 * * Transforms relation metadata into concrete standard Prisma schema syntax string declarations
 * for model definitions.
 * * @param entities - List of entity references mapping IDs to table names.
 * @param relations - List of active relationships between entities.
 * @returns A Map where key = entityId and value = array of formatted Prisma schema code lines.
 */
export function buildRelationLinesByEntity(entities: EntityRef[], relations: RelationRow[]): Map<string, string[]> {
    // Calculates metadata attributes for all relations across entities
    const metaByEntity = computeRelationFieldsByEntity(entities, relations);
    const linesByEntity = new Map<string, string[]>();

    // Iterates through calculated metadata and maps each entry to its Prisma schema DSL string lines
    for (const [entityId, metas] of metaByEntity.entries()) {
        linesByEntity.set(
            entityId,
            metas.flatMap((meta) => buildLinesForMeta(meta)),
        );
    }
    return linesByEntity;
}

/**
 * Helper function that translates a single `RelationFieldMeta` definition into
 * valid Prisma Schema Language (DSL) lines.
 * * @param meta - Metadata object describing the relation field.
 * @returns An array of code lines corresponding to the relation field declarations.
 */
function buildLinesForMeta(meta: RelationFieldMeta): string[] {
    // 1. Handles the side of the relation storing the scalar Foreign Key column
    if (meta.hasScalarFk) {
        // Adds `@unique` attribute if the relationship is ONE_TO_ONE
        const uniqueAttr = meta.isUniqueFk ? ' @unique' : '';
        return [
            `  ${meta.fieldName}Id String${uniqueAttr}`,
            `  ${meta.fieldName} ${meta.targetModelName} @relation("${meta.relationName}", fields: [${meta.fieldName}Id], references: [id])`,
        ];
    }

    // 2. Handles array/list relations (e.g., ONE_TO_MANY target side or MANY_TO_MANY sides)
    if (meta.isList) {
        return [`  ${meta.fieldName} ${meta.targetModelName}[] @relation("${meta.relationName}")`];
    }

    // 3. Handles optional scalar back-relations (e.g., ONE_TO_ONE non-FK side)
    return [`  ${meta.fieldName} ${meta.targetModelName}? @relation("${meta.relationName}")`];
}
