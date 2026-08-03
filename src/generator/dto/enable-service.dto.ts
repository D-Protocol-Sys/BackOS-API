import { IsString, IsObject } from 'class-validator';

export class EnableServiceDto {

    @IsString()
    serviceKey!: string;

    @IsObject()
    config!: Record<string, unknown>;

}