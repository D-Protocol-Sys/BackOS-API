import {
    computeRelationFieldsByEntity,
    RelationRow,
    EntityRef,
    RelationFieldMeta,
} from './relation-metadata.util';

export function buildRelationLinesByEntity(
    entities: EntityRef[],
    relations: RelationRow[],
): Map<string, string[]> {
    const metaByEntity = computeRelationFieldsByEntity(entities, relations);
    const linesByEntity = new Map<string, string[]>();

    for (const [entityId, metas] of metaByEntity.entries()) {
        linesByEntity.set(entityId, metas.flatMap((meta) => buildLinesForMeta(meta)));
    }
    return linesByEntity;
}

function buildLinesForMeta(meta: RelationFieldMeta): string[] {
    if (meta.hasScalarFk) {
        const uniqueAttr = meta.isUniqueFk ? ' @unique' : '';
        return [
            `  ${meta.fieldName}Id String${uniqueAttr}`,
            `  ${meta.fieldName} ${meta.targetModelName} @relation("${meta.relationName}", fields: [${meta.fieldName}Id], references: [id])`,
        ];
    }
    if (meta.isList) {
        return [`  ${meta.fieldName} ${meta.targetModelName}[] @relation("${meta.relationName}")`];
    }
    return [`  ${meta.fieldName} ${meta.targetModelName}? @relation("${meta.relationName}")`];
}