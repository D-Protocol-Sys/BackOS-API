import { IsArray, ArrayNotEmpty, IsString } from 'class-validator';

export class ReplaceRolePermissionsDto {

    @IsArray()
    @ArrayNotEmpty()
    @IsString({ each: true })
    permissionKeys!: string[];

}