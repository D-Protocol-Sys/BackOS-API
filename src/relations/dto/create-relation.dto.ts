import { IsUUID, IsEnum, IsString, MinLength, MaxLength } from 'class-validator';
import { RelationType } from '@prismamodels/client';

/**
 * Data Transfer Object (DTO) used when creating a relation mapping 
 * between two entities/models (e.g., ONE_TO_MANY, MANY_TO_MANY).
 */
export class CreateRelationDto {
    
    /**
     * The structural type of the relationship.
     * Enforces that the input strictly matches a valid `RelationType` enum value.
     */
    @IsEnum(RelationType)
    type!: RelationType;

    /**
     * The unique identifier (UUID v4) of the primary/source entity (Entity A).
     */
    @IsUUID()
    entityAId!: string;

    /**
     * The unique identifier (UUID v4) of the target/related entity (Entity B).
     */
    @IsUUID()
    entityBId!: string;

    /**
     * The field name representing the relation on Entity A.
     * Must be a string between 1 and 60 characters (e.g., "posts").
     */
    @IsString()
    @MinLength(1)
    @MaxLength(60)
    fieldNameOnA!: string;

    /**
     * The reciprocal field name representing the relation back on Entity B.
     * Must be a string between 1 and 60 characters (e.g., "author").
     */
    @IsString()
    @MinLength(1)
    @MaxLength(60)
    fieldNameOnB!: string;
}