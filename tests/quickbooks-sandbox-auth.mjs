import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Save Intuit's rotating grant before any subsequent assertion or API request. */
export async function sandboxAccessToken() {
  const store = process.env.QBO_REFRESH_TOKEN_STORE_SCRIPT;
  assert.ok(store && isAbsolute(store), 'Set QBO_REFRESH_TOKEN_STORE_SCRIPT to the owner-approved local ingestion tool');
  const response = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST', redirect: 'error', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + Buffer.from(process.env.QUICKBOOKS_CLIENT_ID + ':' + process.env.QUICKBOOKS_CLIENT_SECRET).toString('base64') },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: process.env.QBO_REFRESH_TOKEN }),
  });
  const token = await response.json();
  if (typeof token.refresh_token === 'string' && token.refresh_token) {
    const directory = mkdtempSync(join(tmpdir(), 'crank-qbo-rotation-'));
    const file = join(directory, 'rotated.env');
    writeFileSync(file, 'QBO_REFRESH_TOKEN=' + token.refresh_token + '\n', { mode: 0o600 });
    const saved = spawnSync('python3', ['-I', store, file], { stdio: 'ignore' });
    assert.equal(saved.status, 0, 'STOP: refresh-token ingestion failed; recover the private rotated.env before another exchange');
    rmSync(directory, { recursive: true });
    console.log('quickbooks rotating_refresh_token=stored_immediately secret_values=omitted');
  }
  assert.ok(response.ok, `QuickBooks company OAuth grant: provider HTTP ${response.status}`);
  assert.ok(typeof token.refresh_token === 'string' && token.refresh_token, 'QuickBooks must return its current refresh token');
  assert.ok(typeof token.access_token === 'string' && token.access_token, 'QuickBooks must issue company accounting access');
  return token.access_token;
}
