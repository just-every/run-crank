// Task evidence only: use native owner routes and real SQLite; never change product source.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const project = process.cwd();
const load = name => import(pathToFileURL(project + '/' + name).href);
const require = createRequire(pathToFileURL(project + '/package.json'));
const installed = name => import(pathToFileURL(require.resolve(name)).href);
const { harness } = await load('tests/harness.mjs');
const { archive } = await load('tests/restore-journey.mjs');
const { ArchiveVerifier, ContentVerifier } = await installed('@runeditrun/rer/internal/modules/portability/format.mjs');
const { schemaIdentityOf } = await installed('@runeditrun/rer/internal/modules/portability/schema-identity.mjs');
const hash = text => createHash('sha256').update(text).digest('hex');
const trigger = h => h.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='crank_audit_append_only'").first();
const snapshot = async h => {
  const tables = (await h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' ORDER BY name").all()).results;
  return Promise.all(tables.map(async table => ({ ...table, rows: (await h.db.prepare('SELECT * FROM "' + table.name.replaceAll('"', '""') + '"').all()).results })));
};
const older = gunzipSync(await readFile('tests/fixtures/main-agent-archive.rer.gz')).toString('utf8');
const oldManifest = JSON.parse(older.split('\n')[0]);
const oldTrigger = oldManifest.schemaObjects.find(object => object.type === 'trigger' && object.name === 'crank_audit_append_only');
assert.ok(oldTrigger);
const receiving = await harness('http://127.0.0.1:9');
let current, corrupt;
try {
  const expected = (await trigger(receiving)).sql;
  assert.notEqual(oldTrigger.sql, expected, 'historical fixture carries the earlier trigger');
  const restored = await receiving.send('/api/crank/data/restore', { archive: older, confirm: 'RESTORE' }, receiving.owner);
  assert.equal(restored.status, 200, restored.text);
  assert.equal((await trigger(receiving)).sql, expected, 'historical restore retains the current destination trigger');
  console.log(JSON.stringify({ case: 'pre-0093 archive', status: restored.status, original_trigger_sha256: hash(oldTrigger.sql), destination_trigger_sha256: hash(expected), current_schema_retained: true }));

  const exported = await archive(receiving);
  const records = exported.trim().split('\n').map(JSON.parse);
  const archivedTrigger = records[0].schemaObjects.find(object => object.type === 'trigger' && object.name === 'crank_audit_append_only');
  assert.equal(archivedTrigger.sql, expected);
  current = await harness('http://127.0.0.1:9');
  const post = await current.send('/api/crank/data/restore', { archive: exported, confirm: 'RESTORE' }, current.owner);
  assert.equal(post.status, 200, post.text);
  assert.equal((await trigger(current)).sql, expected);
  console.log(JSON.stringify({ case: 'post-0093 archive', status: post.status, trigger_sha256: hash(expected), current_schema_retained: true }));

  archivedTrigger.sql = 'CREATE TRIGGER crank_audit_append_only BEFORE UPDATE ON crank_audit BEGIN SELECT 1; END';
  records[0].schema = await schemaIdentityOf(records[0].tables, records[0].schemaObjects);
  const archiveHash = new ArchiveVerifier(records[0]), content = new ContentVerifier(records[0]);
  for (const part of records.slice(1, -1)) {
    archiveHash.add(part);
    for (const item of part.items) content.add(item);
  }
  records[records.length - 1] = { kind: 'closing', partCount: records.length - 2, contentHash: content.digest(), archiveHash: archiveHash.digest() };
  const tampered = records.map(JSON.stringify).join('\n') + '\n';
  corrupt = await harness('http://127.0.0.1:9');
  await corrupt.get('data/transfers');
  const before = await snapshot(corrupt);
  const refused = await corrupt.send('/api/crank/data/restore', { archive: tampered, confirm: 'RESTORE' }, corrupt.owner);
  assert.equal(refused.status, 400, refused.text);
  assert.equal(refused.value.error, 'schema_mismatch');
  assert.deepEqual(await snapshot(corrupt), before, 'checksummed unknown trigger changes write no rows or schema');
  console.log(JSON.stringify({ case: 'checksummed tampered trigger', status: refused.status, error: refused.value.error, all_rows_and_schema_unchanged: true }));
} finally {
  await corrupt?.close(); await current?.close(); await receiving.close();
}
