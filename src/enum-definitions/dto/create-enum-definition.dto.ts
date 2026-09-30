import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { MAX_ENUM_VALUES, MAX_ENUM_VALUE_LENGTH, ENUM_VALUE_PATTERN } from '../../common/utils/enum-value.util';

export class CreateEnumDefinitionDto {
    /** Display name (e.g. "Project Status"). Free text - only the values below are identifier-shaped. */
    @IsString()
    @MinLength(1)
    @MaxLength(60)
    name!: string;

    /**
     * The options, in order. Each one becomes a Prisma enum member AND the literal value the
     * generated API speaks in - see `ENUM_VALUE_PATTERN` for the shape this restricts them to.
     */
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(MAX_ENUM_VALUES)
    @IsString({ each: true })
    @MaxLength(MAX_ENUM_VALUE_LENGTH, { each: true })
    @Matches(ENUM_VALUE_PATTERN, { each: true })
    values!: string[];
}
