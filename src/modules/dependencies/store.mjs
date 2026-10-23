import { keyPair } from './crypto.mjs';
import { requireInstallationKey, installationKeyId, sealDependencyKey, openDependencyKey } from './sealing.mjs';
import { AuthError } from '../operator-auth/errors.mjs';

async function sealingState(db, config, row, { retiredKeys = [], report } = {}) {
 requireInstallationKey(config);
 const state = row ?? await db.prepare('SELECT keys_sealed,key_ids FROM rer_dependency_installation WHERE singleton=1').first();
 const ids = JSON.parse(state?.key_ids ?? '[]'), current = await installationKeyId(config.INSTALLATION_KEY);
 const previous = config.INSTALLATION_KEY_PREVIOUS ? await installationKeyId(config.INSTALLATION_KEY_PREVIOUS) : null;
 const available = [current, previous, ...await Promise.all(retiredKeys.map(installationKeyId))];
 report?.({keyIds:ids, tail:ids.at(-1) ?? null, custody:ids.map(kid => ({kid, available:available.includes(kid)}))});
 if (ids.length && !available.includes(ids.at(-1))) throw new AuthError('installation_key_unavailable', 503);
 return { current, ids, options: { allowPlaintext: !state?.keys_sealed, knownKeyIds: ids.length ? ids : undefined, retiredKeys } };
}
// Closing the legacy branch is atomic with the last per-row upgrade. This SQL
// checks envelope shape only; reads never decrypt a sibling interface's key.
const finishUpgrade = (db, current) => db.prepare(`UPDATE rer_dependency_installation SET keys_sealed=1,key_ids=CASE WHEN json_array_length(key_ids)=0 THEN ? ELSE key_ids END WHERE singleton=1 AND NOT EXISTS(SELECT 1 FROM rer_dependency_keys WHERE (CASE WHEN json_valid(private_key) THEN json_extract(private_key,'$.version')=1 AND json_type(private_key,'$.kid')='text' AND json_type(private_key,'$.iv')='text' AND json_type(private_key,'$.ciphertext')='text' ELSE 0 END) IS NOT 1)`).bind(JSON.stringify([current]));

// Rekey alone opens the entire table, then checks the complete current set
// (including concurrent replacements) before authorizing key retirement.
export async function resealDependencyKeys(db, config = {}, custody = {}) {
 const state = await sealingState(db, config, undefined, custody);
 const rows = (await db.prepare('SELECT interface,private_key FROM rer_dependency_keys').all()).results;
 const updates = [];
 for (const row of rows) {
  const value = await openDependencyKey(config, row.interface, row.private_key, state.options);
  if (value.reseal) updates.push(db.prepare('UPDATE rer_dependency_keys SET private_key=? WHERE interface=? AND private_key=?').bind(await sealDependencyKey(config, row.interface, value.key), row.interface, row.private_key));
 }
 // Keep all historical IDs, with the current ID last, including a reopen.
 const ids = [...state.ids.filter(id => id !== state.current), state.current];
 await db.batch([...updates, db.prepare('UPDATE rer_dependency_installation SET keys_sealed=1,key_ids=? WHERE singleton=1').bind(JSON.stringify(ids))]);
 for (const row of (await db.prepare('SELECT interface,private_key FROM rer_dependency_keys').all()).results) await openDependencyKey(config, row.interface, row.private_key, { currentOnly: true, knownKeyIds: ids });
 return { resealed: updates.length };
}
export function dependencyStore(db, config = {}) {
 const first=(sql,...args)=>db.prepare(sql).bind(...args).first();
 const run=(sql,...args)=>db.prepare(sql).bind(...args).run();
 async function identity() {
  requireInstallationKey(config);
  const ids = JSON.stringify([await installationKeyId(config.INSTALLATION_KEY)]);
  await run('INSERT INTO rer_dependency_installation(singleton,sector_id,keys_sealed,key_ids) VALUES(1,?,1,?) ON CONFLICT DO NOTHING',crypto.randomUUID(),ids);
  // An archive retains the sector but omits signing keys. A fresh relink can
  // establish destination custody only while no private row needs an old key.
  await run('UPDATE rer_dependency_installation SET keys_sealed=1,key_ids=? WHERE singleton=1 AND NOT EXISTS(SELECT 1 FROM rer_dependency_keys)',ids);
  return first('SELECT * FROM rer_dependency_installation WHERE singleton=1');
 }
 async function readKey(contract = 'oidc-provider@1') {
  requireInstallationKey(config);
  const row = await first('SELECT k.private_key,i.keys_sealed,i.key_ids FROM rer_dependency_keys k LEFT JOIN rer_dependency_installation i ON i.singleton=1 WHERE k.interface=?',contract);
  if (!row) return null;
  const state = await sealingState(db, config, row);
  const value = await openDependencyKey(config, contract, row.private_key, state.options);
  if (!value.reseal) return { key: value.key, sealedKey: row.private_key };
  await db.batch([
   db.prepare('UPDATE rer_dependency_keys SET private_key=? WHERE interface=? AND private_key=?').bind(await sealDependencyKey(config, contract, value.key), contract, row.private_key),
   finishUpgrade(db, state.current),
  ]);
  // Use the persisted winner if unlink/replacement raced our CAS.
  return readKey(contract);
 }
 return {
  first,run,readKey,identity,
  async installation(contract = 'oidc-provider@1') {
   const row=await identity();
   if(!await first('SELECT 1 FROM rer_dependency_keys WHERE interface=?',contract)) {
    await run('INSERT INTO rer_dependency_keys(interface,private_key) VALUES(?,?) ON CONFLICT DO NOTHING',contract,await sealDependencyKey(config,contract,await keyPair()));
   }
   return {...row,...await readKey(contract)};
  },
  async link(contract = 'oidc-provider@1') { const row=await first("SELECT * FROM rer_dependency_link WHERE interface=?",contract);return row?{...row,metadata:JSON.parse(row.metadata)}:null; },
 };
}
