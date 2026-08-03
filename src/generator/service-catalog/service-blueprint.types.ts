export interface ServiceConfigField {
    key: string;
    label: string;
    secret: boolean;
    required: boolean;
    placeholder?: string;
}

export interface ServiceBlueprint {
    key: string;
    name: string;
    description: string;
    pnpmDependencies: Record<string, string>;
    configFields: ServiceConfigField[];
    prismaModels?: string;
}