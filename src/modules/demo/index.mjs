// Import first in the Worker entry. Production build/deploy rejects RER_DEMO.
import { env } from 'cloudflare:workers';
import { installDemoEffects, guardConnect as checkConnect } from './effects.mjs';
import { decorateLabel } from './label.mjs';

const on = env?.RER_DEMO === '1';
if (on) installDemoEffects();
let database = 'DB';
const db = () => env[database];

/** Direct mail transports are denied; use demoEffect around non-HTTP sends. */
export function guardConnect(address) { if (on) checkConnect(address); }

/** Non-HTTP effects (bindings, SDKs): supply the provider's success shape. */
export async function demoEffect(send, success) {
  return on ? (typeof success === 'function' ? success() : success) : send();
}

/** A public read/check which uses POST, for example a monitor or DNS query. */
export { fetchDemoRead } from './effects.mjs';

let tables;
function ready() {
  return tables ??= db().batch([
    db().prepare('CREATE TABLE IF NOT EXISTS rer_demo (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)'),
  ]).catch(error => { tables = undefined; throw error; });
}

// Base operator-auth's owner; a seed with its own accounts passes `owner`.
async function operatorOwner(bindings) {
  const row = await bindings[database].prepare("SELECT email FROM oa_operators WHERE role = 'owner' AND status = 'active' ORDER BY created_at LIMIT 1").first();
  return row?.email ?? null;
}

let seeded = false, seeding;
async function seedOnce(bindings, seed, owner) {
  if (seeded) return;
  await ready();
  if (!seed) { seeded = true; return; }
  if (await db().prepare("SELECT 1 FROM rer_demo WHERE name = 'seeded'").first()) { seeded = true; return; }
  const ownerEmail = await owner(bindings);
  if (!ownerEmail) return;
  const now = new Date();
  await seed(bindings, { ownerEmail, now });
  await db().prepare("INSERT OR IGNORE INTO rer_demo(name, value) VALUES ('seeded', ?)").bind(now.toISOString()).run();
  seeded = true;
}

/** Adds demo data and product labels; all effects are real without RER_DEMO. */
export function withDemo(worker, { seed, binding = 'DB', owner = operatorOwner } = {}) {
  if (!on) return worker;
  database = binding;
  const prepared = bindings => seeding ??= seedOnce(bindings, seed, owner).finally(() => { seeding = undefined; });
  return {
    ...worker,
    async fetch(request, bindings, execution) {
      await prepared(bindings);
      return decorateLabel(await worker.fetch(request, bindings, execution), 'Demo');
    },
    ...(worker.scheduled ? { async scheduled(controller, bindings, execution) { await prepared(bindings); return worker.scheduled(controller, bindings, execution); } } : {}),
    ...(worker.queue ? { async queue(batch, bindings, execution) { await prepared(bindings); return worker.queue(batch, bindings, execution); } } : {}),
  };
}
