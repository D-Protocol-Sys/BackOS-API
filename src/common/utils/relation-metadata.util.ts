import { toPascalCase } from './case.util';

export interface RelationRow {
    id: string;
    type: 'ONE_TO_ONE' | 'ONE_TO_MANY' | 'MANY_TO_MANY';
    entityAId: string;
    entityBId: string;
    fieldNameOnA: string;
    fieldNameOnB: string;
}

export interface EntityRef {
    id: string;
    tableName: string;
}

export interface RelationFieldMeta {
    fieldName: string;
    isList: boolean;
    hasScalarFk: boolean;
    isUniqueFk: boolean;
    isManyToMany: boolean;
    targetModelName: string;
    relationName: string;
}

function relationName(relationId: string): string {
    return `Rel_${relationId.replace(/-/g, '').slice(0, 20)}`;
}

export function computeRelationFieldsByEntity(
    entities: EntityRef[],
    relations: RelationRow[],
): Map<string, RelationFieldMeta[]> {

    const idToTable = new Map(entities.map((e) => [e.id, e.tableName]));
    const result = new Map<string, RelationFieldMeta[]>();

    const push = (entityId: string, meta: RelationFieldMeta) => {
        result.set(entityId, [...(result.get(entityId) ?? []), meta]);
    };

    for (const relation of relations) {
        const tableA = idToTable.get(relation.entityAId);
        const tableB = idToTable.get(relation.entityBId);
        if (!tableA || !tableB) continue;

        const modelA = toPascalCase(tableA);
        const modelB = toPascalCase(tableB);
        const relName = relationName(relation.id);

        if (relation.type === 'ONE_TO_ONE') {
            push(relation.entityAId, {
                fieldName: relation.fieldNameOnA, isList: false, hasScalarFk: true,
                isUniqueFk: true, isManyToMany: false, targetModelName: modelB, relationName: relName,
            });
            push(relation.entityBId, {
                fieldName: relation.fieldNameOnB, isList: false, hasScalarFk: false,
                isUniqueFk: false, isManyToMany: false, targetModelName: modelA, relationName: relName,
            });
            } else if (relation.type === 'ONE_TO_MANY') {
            push(relation.entityAId, {
                fieldName: relation.fieldNameOnA, isList: true, hasScalarFk: false,
                isUniqueFk: false, isManyToMany: false, targetModelName: modelB, relationName: relName,
            });
            push(relation.entityBId, {
                fieldName: relation.fieldNameOnB, isList: false, hasScalarFk: true,
                isUniqueFk: false, isManyToMany: false, targetModelName: modelA, relationName: relName,
            });
            } else {
            push(relation.entityAId, {
                fieldName: relation.fieldNameOnA, isList: true, hasScalarFk: false,
                isUniqueFk: false, isManyToMany: true, targetModelName: modelB, relationName: relName,
            });
            push(relation.entityBId, {
                fieldName: relation.fieldNameOnB, isList: true, hasScalarFk: false,
                isUniqueFk: false, isManyToMany: true, targetModelName: modelA, relationName: relName,
            });
        }
    }

    return result;
}