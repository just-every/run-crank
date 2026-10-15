/** Under `rer demo`, resolves the Worker's `cloudflare:sockets` imports to demo mode's guarded connect. */
export function demoSockets(): { name: string; apply: 'serve'; enforce: 'pre'; config(): object | undefined; resolveId(id: string): string | undefined };
