export const DEV_KEY_FILE: string;
export function readDevKey(root: string): Promise<string>;
export function signInAs(input: { origin: string; key: string; as?: string; returnTo?: string }): Promise<{ cookies: { name: string; value: string }[]; location: string | null; header: string }>;
