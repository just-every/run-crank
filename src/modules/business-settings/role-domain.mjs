// One role domain for runtime admission and the generated portable setup schema.
// Without the Unicode flag, the bound counts UTF-16 units like String.length.
export const businessTeamRoleSchema = Object.freeze({
  type: 'string',
  pattern: '^(?![Oo][Ww][Nn][Ee][Rr]$)(?!\\s)(?![\\s\\S]*\\s$)[^\\x00-\\x1f\\x7f-\\x9f]{1,64}$',
  description: 'Seed-owned role name for Business teammates. Must never grant ownership; the seed adapter also enforces its native ownership rules.',
});

const rolePattern = new RegExp(businessTeamRoleSchema.pattern);
export function isBusinessTeamRole(value) {
  return typeof value === 'string' && rolePattern.test(value);
}
