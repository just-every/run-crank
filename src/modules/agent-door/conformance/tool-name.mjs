// One grammar for declaration validation, runtime registration and MCP exposure.
// MCP tool names are limited to 128 ASCII letters, digits, underscores, dots or
// hyphens. The seed prefix retains the existing seed-id grammar.
export function validToolName(name, seed) {
 return typeof name === 'string' && name.length <= 128 &&
  /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(name) && name.split('.')[0] === seed;
}
