import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { MAX_ENUM_VALUES, MAX_ENUM_VALUE_LENGTH, ENUM_VALUE_PATTERN } from '../../common/utils/enum-value.util';

export class UpdateEnumDefinitionDto {
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(60)
    name?: string;

    @IsOptional()
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(MAX_ENUM_VALUES)
    @IsString({ each: true })
    @MaxLength(MAX_ENUM_VALUE_LENGTH, { each: true })
    @Matches(ENUM_VALUE_PATTERN, { each: true })
    values?: string[];
}
