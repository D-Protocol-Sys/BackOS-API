/**
 * Utility functions for string casing conversions (Snake_case to PascalCase / camelCase).
 */

/**
 * Converts a string formatted in snake_case to PascalCase.
 * * @param snakeCase - The input string using underscores (e.g., "user_account_setting").
 * @returns The formatted PascalCase string (e.g., "UserAccountSetting").
 * * @example
 * toPascalCase("user_first_name") // Returns "UserFirstName"
 * toPascalCase("user__name")       // Returns "UserName" (handles duplicate underscores safely)
 */
export function toPascalCase(snakeCase: string): string {
    return snakeCase
        .split('_') // Splits the string into an array of words wherever an underscore is found
        .filter(Boolean) // Filters out empty strings created by leading, trailing, or consecutive underscores
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1)) // Capitalizes the first letter of each word
        .join(''); // Concatenates all capitalized words into a single string
}

/**
 * Converts a string formatted in snake_case to camelCase.
 * * Reuses `toPascalCase` to handle word split and capitalization logic,
 * then simply lowers the first character.
 * * @param snakeCase - The input string using underscores (e.g., "user_account_setting").
 * @returns The formatted camelCase string (e.g., "userAccountSetting").
 * * @example
 * toCamelCase("user_first_name") // Returns "userFirstName"
 */
export function toCamelCase(snakeCase: string): string {
    // Converts the string to PascalCase first (e.g., "UserFirstName")
    const pascal = toPascalCase(snakeCase);

    // Lowers the very first character while preserving the rest of the string
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
