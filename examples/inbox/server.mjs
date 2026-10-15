// A small, real receiving application for the Crank HTTP connector.
// Keeps its inbox in SQLite; an idempotency key can never create two messages.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const port = Number(process.env.INBOX_PORT || 9051);
const directory = resolve(process.env.INBOX_DATA || '.rer/inbox');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(resolve(directory, 'inbox.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, digest TEXT NOT NULL, body TEXT NOT NULL, received TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL);
INSERT OR IGNORE INTO settings VALUES(1,0);`);
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const server = createServer(async (request, response) => {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  const reply = (status, value) => { response.writeHead(status, { 'content-type':'application/json' }); response.end(JSON.stringify(value)); };
  const expectedOrigin = `http://127.0.0.1:${port}`;
  if (request.headers.host !== `127.0.0.1:${port}`) return reply(403, {error:'Use the printed loopback address.'});
  if (request.method === 'POST' && request.url === '/pause') {
    if (request.headers.origin !== expectedOrigin) return reply(403, {error:'Origin required'});
    db.prepare('UPDATE settings SET paused=1-paused WHERE id=1').run();
    response.writeHead(303, { location:'/' }); return response.end();
  }
  if (request.method === 'GET' && request.url === '/') {
    const paused = db.prepare('SELECT paused FROM settings').get().paused;
    const messages = db.prepare('SELECT * FROM messages ORDER BY received DESC').all();
    response.writeHead(200, {'content-type':'text/html; charset=utf-8', 'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"});
    return response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Operations inbox</title><style>body{font:16px system-ui;background:#f3f5f8;color:#172033;margin:0;padding:24px}main{max-width:800px;margin:auto}article,header{background:white;padding:24px;margin-bottom:16px;border-radius:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{padding:12px;font:inherit;cursor:pointer}</style><main><header><h1>Operations inbox</h1><p>A receiving app with durable, duplicate-safe messages.</p><p>${messages.length} messages · Receiving ${paused?'paused':'enabled'}</p><form method="post" action="/pause"><button>${paused?'Resume receiving':'Pause receiving'}</button></form></header>${messages.map(m=>`<article><p>Received ${escape(m.received)}</p><pre>${escape(JSON.stringify(JSON.parse(m.body),null,2))}</pre><small>Delivery ${escape(m.id)}</small></article>`).join('') || '<p>No messages yet. Approve a run in Crank to deliver one.</p>'}</main></html>`);
  }
  if (request.method !== 'POST' || request.url !== '/events') return reply(404, {error:'Not found'});
  if (request.headers.origin && request.headers.origin !== expectedOrigin) return reply(403, {error:'Cross-origin browser submission refused'});
  const id = request.headers['idempotency-key'];
  if (typeof id !== 'string' || !/^[\w:-]{1,128}$/.test(id)) return reply(400, {error:'Idempotency-Key required'});
  let body = '';
  try { for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body)>65536) return reply(413,{error:'Event too large'}); } JSON.parse(body); }
  catch { return reply(400, {error:'JSON event required'}); }
  const digest = createHash('sha256').update(body).digest('hex');
  const existing = db.prepare('SELECT digest FROM messages WHERE id=?').get(id);
  if (existing && existing.digest !== digest) return reply(409,{error:'Key already used for different input'});
  if (existing) return reply(200,{id, idempotencyKey:id});
  if (db.prepare('SELECT paused FROM settings').get().paused) return reply(503,{error:'Receiving paused'});
  db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(id,digest,body,new Date().toISOString());
  reply(201,{id, idempotencyKey:id});
});
server.listen(port,'127.0.0.1',()=>console.log(`Operations inbox: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>server.close(()=>{db.close();process.exit(0);}));
