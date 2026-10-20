// Process boundary only: application code is always the emitted deployment.
// IPC can install the real schema or invoke the platform Cron door; it cannot
// manufacture runs, checkpoints, leases, operation outcomes or application data.
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

let mf;
const mail = [];
process.on('message', async ({ id, action, config, time }) => {
  try {
    let value;
    if (action === 'start') {
      const bindings = { AUTH_ORIGIN: config.origin, AUTH_LOCAL: 'true', OWNER_EMAIL: 'recovery-owner@example.test', SESSION_SECRET: config.sessionSecret, SETUP_TOKEN: config.setupToken,
        MAIL_PROVIDER: 'resend', MAIL_API_KEY: 'synthetic-network-edge', MAIL_FROM: 'Crank <auth@example.test>', CRANK_TARGET_ORIGIN: 'https://emitted-recovery.example' };
      for (const name of config.omit ?? []) delete bindings[name];
      const modules = [{ type: 'ESModule', path: resolve('dist/server/index.js') }, ...(await readdir('dist/server/assets')).filter(file => file.endsWith('.js')).map(file => ({ type: 'ESModule', path: resolve('dist/server/assets', file) }))];
      mf = new Miniflare({ ...convertV4MiniflareOptions({ host: '127.0.0.1', port: config.port, upstream: config.origin, modules, modulesRoot: resolve('dist/server'),
        compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'], bindings,
        d1Databases: config.omit?.includes('DB') ? {} : { DB: 'emitted-recovery' },
        outboundService: async request => {
          const url = new URL(request.url);
          // Only external receiver and mail edges are faked. Unknown network
          // requests fail visibly rather than contacting a real provider.
          if (url.hostname === 'api.resend.com') { mail.push(await request.json()); return Response.json({ id: 'synthetic-mail' }); }
          if (url.hostname !== 'emitted-recovery.example') throw new Error('Unexpected external network edge');
          const headers = new Headers(request.headers); headers.delete('content-length'); headers.delete('host');
          return fetch(config.receiver + url.pathname + url.search, { method: request.method, headers,
            body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(), redirect: 'manual', signal: request.signal });
        },
      }), resourcePersistencePath: config.persist });
      await mf.ready;
    } else if (action === 'migrate') {
      const db = await mf.getD1Database('DB');
      for (const file of (await readdir('migrations/core')).filter(file => file.endsWith('.sql')).sort()) {
        await db.batch(unstable_splitSqlQuery(await readFile('migrations/core/' + file, 'utf8')).map(sql => db.prepare(sql)));
      }
    } else if (action === 'tick') {
      await (await mf.getWorker()).scheduled({ scheduledTime: new Date(time), cron: '* * * * *' });
    } else if (action === 'mail') {
      value = mail;
    } else if (action === 'await-building-export') {
      const db = await mf.getD1Database('DB'), deadline = Date.now() + 10000;
      // Read-only observation of actual archive progress. Polling yields to D1
      // on every query and never manufactures an interrupted transfer.
      while (Date.now() < deadline) {
        value = await db.prepare("SELECT id,phase,completed FROM rer_portability_jobs WHERE kind='export' AND phase='building' ORDER BY rowid DESC LIMIT 1").first();
        if (value) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      if (!value) throw new Error('No building export observed');
    } else throw new Error('Unknown fixture command');
    process.send({ id, ok: true, value });
  } catch {
    // Never echo Worker environment, mail, private URLs or provider exceptions.
    process.send({ id, ok: false, error: `Emitted recovery fixture ${action} failed` });
  }
});
