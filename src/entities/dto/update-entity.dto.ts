import { PartialType } from '@nestjs/mapped-types';
import { CreateEntityDto } from './create-entity.dto';

/**
 * Data Transfer Object (DTO) defining the schema and validation rules 
 * for updating an existing entity record via incoming API payloads.
 * * Extends `CreateEntityDto` using NestJS `PartialType`.
 * This automatically inherits all validation decorators from `CreateEntityDto` 
 * (such as `@IsString()`, `@MinLength()`, `@MaxLength()`) while making every field 
 * optional (`@IsOptional()`), perfect for partial updates (`PATCH` HTTP requests).
 * * @example
 * ```ts
 * // Incoming PATCH payload can send `{ name: "Updated Name" }` or `{}`
 * @Patch(':id')
 * update(@Param('id') id: string, @Body() updateDto: UpdateEntityDto) { ... }
 * ```
 */
export class UpdateEntityDto extends PartialType(CreateEntityDto) {}