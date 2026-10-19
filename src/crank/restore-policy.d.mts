export declare const RESTORED_OWNER: string;
export declare const importSafety: Record<string, Record<string, unknown[]>>;
export declare function fenceRow(table: string, row: Record<string, unknown>): Record<string, unknown>;
export declare function importRow(table: string, row: Record<string, unknown>): Record<string, unknown>;
export declare function validateRestore(input: { read(table: string): Promise<Record<string, any>[]> }): Promise<boolean>;
