import {queuedEntrypoint} from '@runeditrun/rer/queued-entry';
const queued=await queuedEntrypoint(import.meta.url,'verify:email-link');if(queued!==null)process.exit(queued);
// Exercise the real emitted auth flow; only the mail provider network edge is fake.
import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
const h=await harness('https://operations.example.com',{emitted:true});
try {
 const requested=await h.send('/auth/magic-link',{email:'owner@example.test'});
 assert.equal(requested.status,202,requested.text);
 assert.equal((await h.send('/__dev/outbox')).status,404);
 const href=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
 const link=new URL(href);assert.equal(link.origin,h.origin);
 assert.equal((await h.send(link.pathname+link.search)).status,200);
 const confirmed=await h.send('/auth/confirm',{token:link.searchParams.get('token')});
 assert.equal(confirmed.status,303,confirmed.text);
 const session=await h.send('/auth/session',undefined,confirmed.cookie);
 assert.equal(session.status,200);assert.equal(session.value.operator.email,'owner@example.test');
 console.log('Emitted Worker email-link sign-in passed: provider, confirmation, session; no outbox UI');
} finally {await h.close()}
