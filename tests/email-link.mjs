import {queuedEntrypoint} from '@runeditrun/rer/queued-entry';
const queued=await queuedEntrypoint(import.meta.url,'verify:email-link');if(queued!==null)process.exit(queued);
// Exercise the real emitted auth flow; only the mail provider network edge is fake.
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {harness} from './harness.mjs';
const h=await harness('https://operations.example.com',{emitted:true});
try {
 const requested=await h.send('/auth/magic-link',{email:'owner@example.test'});
 assert.equal(requested.status,202,requested.text);
 // SEC-001: the emitted Worker carries no local development identity, even with its local flags set.
 for(const path of ['/__dev/outbox','/__dev/personas','/auth/dev/enter?as=admin','/auth/local/cli-session']) for(const input of [undefined,{}]) assert.equal((await h.send(path,input)).status,404,'SEC-001 dev door '+path);
 const markers=['rer-dev-layer:local-only-never-deploy','rer-ai-dev:local-only-never-deploy'];
 assert.ok((await readFile('src/modules/operator-auth/dev/index.mjs','utf8')).includes(markers[0]),'the dev layer carries its marker');
 for(const entry of await readdir('dist',{recursive:true,withFileTypes:true})) if(entry.isFile()) {
  const bytes=await readFile(join(entry.parentPath,entry.name));assert.ok(markers.every(marker=>!bytes.includes(marker)),'SEC-001: deployed output carries the dev layer: '+join(entry.parentPath,entry.name));
 }
 const href=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
 const link=new URL(href);assert.equal(link.origin,h.origin);
 assert.equal((await h.send(link.pathname+link.search)).status,200);
 const confirmed=await h.send('/auth/confirm',{token:link.searchParams.get('token')});
 assert.equal(confirmed.status,303,confirmed.text);
 const session=await h.send('/auth/session',undefined,confirmed.cookie);
 assert.equal(session.status,200);assert.equal(session.value.operator.email,'owner@example.test');
 console.log('Emitted Worker email-link sign-in passed: provider, confirmation, session; no dev identity doors or dev layer in the output (SEC-001)');
} finally {await h.close()}
