import type { AccountsAdapter, Action, Operator, PolicyInput, Role } from '../index.mjs';
export function accountsAdapter<T extends AccountsAdapter<string>>(adapter: T): T;
export const DEFAULT_ROLES: readonly Role[];
export const ACTIONS: readonly Action[];
export function defaultRolePolicy(input: PolicyInput): boolean;
export function isActiveOperator(operator: Operator | null | undefined, allowList?: string[]): boolean;
export function emailAllowed(email: string, allowList?: string[]): boolean;

export function requireEditorOwner<R extends string>(options:{request:Request;getSession:(request:Request)=>Promise<import('../index.mjs').Session<R>|null>;accounts:import('../index.mjs').AccountsAdapter<R>}):Promise<import('../index.mjs').Session<R>>;
