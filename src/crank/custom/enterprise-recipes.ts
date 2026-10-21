import { checkEgress } from '../engine/egress'
import { requireValue } from '../model'
import { boundedJson, keys, object, parseDefinition, string, strings, type CustomDefinition } from './definition'

export const ENTERPRISE_RECIPE_IDS = ['servicenow_incidents', 'sap_business_partners'] as const
export type EnterpriseRecipeId = typeof ENTERPRISE_RECIPE_IDS[number]
export interface EnterpriseRecipeRequest {
  recipe: EnterpriseRecipeId
  tenant_origin: string
  id: string
  version: number
  /** Exact scope names from the tenant's configured OAuth application, never credentials. */
  scopes: string[]
  disclosure: CustomDefinition['disclosure']
}

const recipes = {
  servicenow_incidents: {
    name: 'ServiceNow incidents', operation: 'get_incident', operationName: 'Read incident', key: 'sys_id',
    path: '/api/now/table/incident/{sys_id}',
  },
  sap_business_partners: {
    name: 'SAP S/4HANA business partners', operation: 'get_business_partner', operationName: 'Read business partner', key: 'BusinessPartner',
    path: "/sap/opu/odata/SAP/API_BUSINESS_PARTNER/A_BusinessPartner(BusinessPartner='{BusinessPartner}')",
  },
} as const

/** Pure proposal construction: no storage, credential access, consent or network requests. */
export function proposeEnterpriseRecipe(value: unknown): CustomDefinition {
  boundedJson(value)
  const input = object(value, 'Enterprise recipe request')
  keys(input, ['recipe', 'tenant_origin', 'id', 'version', 'scopes', 'disclosure'], 'Enterprise recipe request')
  requireValue(ENTERPRISE_RECIPE_IDS.includes(input.recipe as EnterpriseRecipeId), 'Choose a supported enterprise read recipe')
  const recipe = recipes[input.recipe as EnterpriseRecipeId]
  const rawOrigin = string(input.tenant_origin, 'Tenant origin', 2000)
  requireValue(/^https:\/\/[^/?#]+\/?$/.test(rawOrigin) && !/[\\\s{}]/.test(rawOrigin), 'Tenant origin must be literal HTTPS without a path, query, fragment or variables')
  const tenant = checkEgress(rawOrigin)
  requireValue(tenant.protocol === 'https:' && tenant.pathname === '/' && !tenant.search && !tenant.hash, 'Tenant origin must be HTTPS without a path, query or fragment')
  const scopes = strings(input.scopes, 'Tenant OAuth scopes')
  const disclosure = object(input.disclosure, 'Enterprise data disclosure')
  requireValue(disclosure.recipient === tenant.origin, 'Disclosure recipient must equal the canonical tenant HTTPS origin')
  requireValue(Array.isArray(disclosure.fields) && disclosure.fields.includes(recipe.key), 'Disclosure fields must include the record key sent to the tenant')
  const path = tenant.origin + recipe.path
  checkEgress(path.replace(/\{[^}]+\}/g, 'sample'))
  return parseDefinition({
    id: input.id, name: recipe.name, version: input.version,
    auth: { kind: 'oauth2', scopes }, disclosure,
    operations: [{ id: recipe.operation, name: recipe.operationName, kind: 'action', method: 'GET', path, scopes,
      inputs: { [recipe.key]: { type: 'string', required: true, location: 'path', ...(input.recipe==='sap_business_partners'?{encoding:'odata-string'}:{}) } } }],
  })
}
