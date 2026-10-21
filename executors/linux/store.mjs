import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const stable = (value) => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  : value;
export const identity = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

export function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(dataDir);
  const info = fs.statSync(root);
  if (info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Data directory must be private and owned by the executor user');
  const tasks = path.join(root, 'tasks');
  fs.mkdirSync(tasks, { mode: 0o700 });
  function save(record) {
    const dir = path.join(tasks, record.task_id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = path.join(dir, `state-${randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, path.join(dir, 'state.json'));
    const directory = fs.openSync(dir, 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    const parent = fs.openSync(tasks, 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    return record;
  }
  function read(id) {
    try { return JSON.parse(fs.readFileSync(path.join(tasks, id, 'state.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function erase(id) { fs.rmSync(path.join(tasks, id, 'job'), { recursive: true, force: true }); }
  function recover() {
    for (const entry of fs.readdirSync(tasks, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const record = read(entry.name);
      if (record && !terminal.has(record.status)) save({ ...record, status: 'interrupted', error: { category: 'interrupted', message: 'Executor restarted; task outcome is uncertain and it will not be relaunched.' } });
      erase(entry.name);
    }
  }
  return { root, tasks, save, read, erase, recover };
}

export function publicTask(record) {
  const result = { task_id: record.task_id, status: record.status };
  if (Object.hasOwn(record, 'output')) result.output = record.output;
  if (record.error) result.error = record.error;
  return result;
}
