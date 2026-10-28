export const businessTeamRoleSchema: Readonly<{
  type: 'string';
  pattern: string;
  description: string;
}>;
export function isBusinessTeamRole(value: unknown): value is string;
