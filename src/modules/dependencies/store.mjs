import { keyPair } from './crypto.mjs';
export function dependencyStore(db) {
 const first=(sql,...args)=>db.prepare(sql).bind(...args).first();
 const run=(sql,...args)=>db.prepare(sql).bind(...args).run();
 return {
  first,run,
  async installation(contract = 'oidc-provider@1') {
   await run('INSERT INTO rer_dependency_installation(singleton,sector_id) VALUES(1,?) ON CONFLICT DO NOTHING',crypto.randomUUID());
   const row=await first('SELECT * FROM rer_dependency_installation WHERE singleton=1');
   let key=await first('SELECT private_key FROM rer_dependency_keys WHERE interface=?',contract);
   if(!key) {
    await run('INSERT INTO rer_dependency_keys(interface,private_key) VALUES(?,?) ON CONFLICT DO NOTHING',contract,JSON.stringify(await keyPair()));
    key=await first('SELECT private_key FROM rer_dependency_keys WHERE interface=?',contract);
   }
   return {...row,key:JSON.parse(key.private_key)};
  },
  async link(contract = 'oidc-provider@1') { const row=await first("SELECT * FROM rer_dependency_link WHERE interface=?",contract);return row?{...row,metadata:JSON.parse(row.metadata)}:null; },
 };
}
