/** Supplies public demo navigation metadata and guards local demo sockets. */
export function demoSockets(): {
  name: string;
  enforce: 'pre';
  config(config: { root?: string }, environment: { command: string }): Promise<object>;
  resolveId(id: string): string | undefined;
};
