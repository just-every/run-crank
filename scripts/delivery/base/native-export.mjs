import {splitSqlStatements} from './sql-statements.mjs';

const sqlSpace = '(?:\\s|--[^\\n]*(?:\\n|$)|/\\*[\\s\\S]*?\\*/)*';
const createVirtualTable = new RegExp(`^${sqlSpace}CREATE\\b${sqlSpace}VIRTUAL\\b${sqlSpace}TABLE\\b`, 'i');
const exportPath = /^\/(?:[A-Za-z0-9._~-]+\/?)*$/;

/** Match platform's native export contract against the collected binding and SQL declarations. */
export function validateNativeExport(declaration, context) {
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration) || Object.keys(declaration).sort().join(',') !== 'covers,path') throw Error('Native export declaration requires exactly path and covers');
  const {path, covers} = declaration;
  if (typeof path !== 'string' || path.length > 256 || !exportPath.test(path) || path.split('/').some(segment => segment === '.' || segment === '..')) throw Error('Native export path must be a same-origin application path such as /export');
  if (!Array.isArray(covers) || !covers.length || covers.length > 64 || new Set(covers).size !== covers.length) throw Error('Native export must cover one or more distinct bindings');
  for (const binding of covers) {
    const database = context.resources.find(resource => resource.binding === binding && resource.kind === 'd1');
    const virtual = () => Boolean(context.migrations?.some(migration => migration.binding === binding && splitSqlStatements(migration.sql).some(statement => createVirtualTable.test(statement))));
    if (database ? virtual() : context.durableObjects.some(object => object.binding === binding)) continue;
    throw Error(`Native export may cover only D1 databases with virtual tables and Durable Objects: ${String(binding)}`);
  }
}
