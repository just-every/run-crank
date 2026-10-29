// A no-subject security tool may change a record, but its declared input must
// have no place to carry an authority subject, role or grant. Fail closed on
// open objects, opaque schemas, references and unbounded schema composition.
const subject = /(?:^|_)(?:person|people|user|member|owner|sponsor|agent|role|scope|grant|credential|permission|authorit(?:y|ies)|principal|privilege|entitlement|capabilit(?:y|ies)|authorization|identity|consent|token)(?:s|id|ids)?(?:_|$)/;
const field = name => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_');
export function recordOnlySchema(schema, depth = 0) {
 if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 32
  || Object.keys(schema).some(key => ['$ref', '$dynamicRef', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'patternProperties', 'dependentSchemas', 'unevaluatedProperties'].includes(key))) return false;
 if (schema.type === 'object') return schema.additionalProperties === false && schema.properties !== null && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
  && Object.entries(schema.properties).every(([name, value]) => !subject.test(field(name)) && recordOnlySchema(value, depth + 1));
 if (schema.type === 'array') return recordOnlySchema(schema.items, depth + 1);
 return ['string', 'boolean', 'number', 'integer', 'null'].includes(schema.type);
}
export const recordOnlyAuthority = tool => tool?.authority === 'none' && tool.readOnly === false
 && Array.isArray(tool.classes) && tool.classes.includes('security') && !tool.classes.includes('access')
 && tool.effect?.kind === 'record' && typeof tool.effect.justification === 'string' && tool.effect.justification.trim().length > 0
 && recordOnlySchema(tool.inputSchema);
