export function toPascalCase(snakeCase: string): string {
    return snakeCase
        .split('_')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

export function toCamelCase(snakeCase: string): string {
    const pascal = toPascalCase(snakeCase);
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}