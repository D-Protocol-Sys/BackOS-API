import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Options of `POST /platforms/:id/generate` and `POST .../generations/:id/approve`.
 *
 * `allowDestructiveMigration` (GEN-001): explicitly accept that the migration generated for this
 * run deletes or rewrites existing data (DROP COLUMN/TABLE, type change...). Only the platform
 * owner or a holder of the global `generator.execute` permission can set it.
 */
export class GenerateOptionsDto {
    @IsOptional()
    @IsBoolean()
    allowDestructiveMigration?: boolean;
}
