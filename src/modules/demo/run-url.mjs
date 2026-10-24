// Shared by Vite and the hosted plan; this file also travels with src/modules/demo.
export function demoRunUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\p{Cc}\\]/u.test(value)) throw new Error('invalid-demo-run-url');
  let run;
  try { run = new URL(value); } catch { throw new Error('invalid-demo-run-url'); }
  if (run.protocol !== 'https:' || run.username || run.password || run.pathname !== '/run' || run.search || run.hash) throw new Error('invalid-demo-run-url');
  if (run.hostname.length > 253 || !/^(?!www\.)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(run.hostname)) throw new Error('invalid-site-domain');
  return run.href;
}
