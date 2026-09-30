import { IsString, MaxLength, MinLength } from 'class-validator';

/** Body of `POST /internal/generated-auth/lookup-member`, sent by a GENERATED BACKEND. */
export class LookupMemberDto {
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    username!: string;
}
