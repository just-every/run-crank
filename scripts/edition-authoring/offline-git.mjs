import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

// Older Git ignores GIT_NO_LAZY_FETCH. Read the real object store through a
// repository with no remotes instead: even missing promisor objects cannot
// launch a fetch. Never load the source's config into this repository.
export function offlineRepository(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^GIT_(?:CONFIG|DIR$|COMMON_DIR$|WORK_TREE$|INDEX_FILE$|OBJECT_DIRECTORY$|ALTERNATE_OBJECT_DIRECTORIES$|SHALLOW_FILE$|NAMESPACE$|QUARANTINE_PATH$|REPLACE_REF_BASE$)/.test(name)));
  Object.assign(env, {GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0'});
  const metadata = (...args) => execFileSync('git', ['-C', root, 'rev-parse', ...args], {env, encoding: 'utf8', stdio: 'pipe'}).trim();
  let temporary;
  try {
    // These queries read repository metadata and refs, never object contents.
    const objects = metadata('--path-format=absolute', '--git-path', 'objects');
    const format = metadata('--show-object-format');
    const head = metadata('--verify', 'HEAD');
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'base-offline-'));
    execFileSync('git', ['init', '--bare', '--quiet', '--template=', `--object-format=${format}`, temporary], {env, stdio: 'pipe'});
    fs.writeFileSync(path.join(temporary, 'HEAD'), head + '\n');
    return {root: temporary, env: {...env, GIT_OBJECT_DIRECTORY: objects}, close: () => fs.rmSync(temporary, {recursive: true, force: true})};
  } catch {
    if (temporary) fs.rmSync(temporary, {recursive: true, force: true});
    throw Error('Cannot prepare the local Base object reader. Ensure Git is installed, the Base checkout and its HEAD are readable, and temporary storage is writable, then retry offline. No copy record was changed.');
  }
}
