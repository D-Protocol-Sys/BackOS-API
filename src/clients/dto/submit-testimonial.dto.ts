import { IsBoolean, IsInt, Max, Min, IsOptional, IsString } from 'class-validator';

/**
 * Data Transfer Object (DTO) for submitting a client testimonial.
 * Validates feedback text, bounded integer ratings, and visibility preferences.
 */
export class SubmitTestimonialDto {
    /**
     * The textual content of the testimonial or review.
     * Mandatory string field.
     */
    @IsString()
    testimonialText!: string;

    /**
     * Numeric rating given by the client.
     * Must be an integer strictly between 1 and 5.
     */
    @IsInt()
    @Min(1)
    @Max(5)
    testimonialRating!: number;

    /**
     * Optional flag indicating if the testimonial is safe for public display.
     */
    @IsBoolean()
    @IsOptional()
    isTestimonialPublic?: boolean;
}