import { toPascalCase } from './case.util';

/**
 * Represents a raw database or schema relationship definition between two entities.
 */
export interface RelationRow {
    id: string;
    type: 'ONE_TO_ONE' | 'ONE_TO_MANY' | 'MANY_TO_MANY';
    entityAId: string; // The primary/origin entity ID
    entityBId: string; // The target/related entity ID
    fieldNameOnA: string; // Field name used on Entity A to reference Entity B
    fieldNameOnB: string; // Field name used on Entity B to reference Entity A
}

/**
 * Minimal reference for an entity mapping its unique ID to a database table name.
 */
export interface EntityRef {
    id: string;
    tableName: string;
}

/**
 * Calculated metadata describing how a relationship field should be generated 
 * on a specific ORM model (e.g., Prisma model field definition).
 */
export interface RelationFieldMeta {
    fieldName: string;        // The property name on the generated model
    isList: boolean;           // Indicates array/plural relations (e.g., Post[])
    hasScalarFk: boolean;      // True if this side of the relation holds the Foreign Key column
    isUniqueFk: boolean;       // True for 1-to-1 relations requiring a UNIQUE constraint on the FK
    isManyToMany: boolean;    // True for implicit or explicit N:M relations
    targetModelName: string;   // PascalCase name of the related model (e.g., "User")
    relationName: string;      // Explicit relation identifier to prevent ORM name collisions
}

/**
 * Utility: Sanitizes a UUID/ID string into a valid, fixed-length ORM relation identifier.
 * * @param relationId - Raw relation UUID (e.g., "a1b2c3d4-e5f6-...").
 * @returns Formatted relation string (e.g., "Rel_a1b2c3d4e5f600000000").
 */
function relationName(relationId: string): string {
    return `Rel_${relationId.replace(/-/g, '').slice(0, 20)}`;
}

/**
 * Maps flat entity and relation configurations into a lookup Map of model metadata,
 * grouped by entity ID. Essential for schema/ORM code generators (e.g., Prisma/TypeORM generators).
 * * @param entities - List of entity references containing table names.
 * @param relations - List of active relationships between entities.
 * @returns A Map where key = entityId and value = array of relation field definitions.
 */
export function computeRelationFieldsByEntity(
    entities: EntityRef[],
    relations: RelationRow[],
): Map<string, RelationFieldMeta[]> {

    // Fast lookup map pairing entity IDs directly to table names: O(1) time complexity per lookup
    const idToTable = new Map(entities.map((e) => [e.id, e.tableName]));
    const result = new Map<string, RelationFieldMeta[]>();

    // Helper: Appends metadata to an entity's array inside the result Map
    const push = (entityId: string, meta: RelationFieldMeta) => {
        result.set(entityId, [...(result.get(entityId) ?? []), meta]);
    };

    for (const relation of relations) {
        const tableA = idToTable.get(relation.entityAId);
        const tableB = idToTable.get(relation.entityBId);
        
        // Guard clause: Skips processing if either entity ID cannot be resolved
        if (!tableA || !tableB) continue;

        // Formats database table names to standard PascalCase ORM model names (e.g., "user_profiles" -> "UserProfile")
        const modelA = toPascalCase(tableA);
        const modelB = toPascalCase(tableB);
        const relName = relationName(relation.id);

        if (relation.type === 'ONE_TO_ONE') {
            // Side A: Holds the scalar Foreign Key with a UNIQUE constraint
            push(relation.entityAId, {
                fieldName: relation.fieldNameOnA, isList: false, hasScalarFk: true,
                isUniqueFk: true, isManyToMany: false, targetModelName: modelB, relationName: relName,
            });
            // Side B: Virtual back-relation (references Side A without storing a foreign key column)
            push(relation.entityBId, {
                fieldName: relation.fieldNameOnB, isList: false, hasScalarFk: false,
                isUniqueFk: false, isManyToMany: false, targetModelName: modelA, relationName: relName,
            });
        } else if (relation.type === 'ONE_TO_MANY') {
            // "ONE" side (Side A): Returns a array/list of related records (no scalar FK)
            push(relation.entityAId, {
                fieldName: relation.fieldNameOnA, isList: true, hasScalarFk: false,
                isUniqueFk: false, isManyToMany: false, targetModelName: modelB, relationName: relName,
            });
            // "MANY" side (Side B): Holds the scalar Foreign Key referencing Side A
            push(relation.entityBId, {
                fieldName: relation.fieldNameOnB, isList: false, hasScalarFk: true,
                isUniqueFk: false, isManyToMany: false, targetModelName: modelA, relationName: relName,
            });
        } else {
            // "MANY TO MANY" (Sides A & B): Both sides return lists and flag isManyToMany as true
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