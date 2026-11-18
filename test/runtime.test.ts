import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanup, onCleanup } from './support/cleanup';

afterEach(cleanup);

for (const script of ['e2e.ts','run-zotero.ts']) test(`${script} rejects command-line API keys without echoing them`, () => {
 const secret = 'never-provisioned-test-key';
 for (const args of [['--apikey',secret],[`--apikey=${secret}`]]) {
  const result = spawnSync(process.execPath,["--import", "tsx", `scripts/${script}`,...args], { encoding:'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status,2);
  assert.match(result.stderr,/use TOPK_API_KEY/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
 }
});

test('dev launcher tightens existing profile and credential-file permissions', { skip: process.platform === 'win32' }, () => {
 const dir = mkdtempSync(path.join(tmpdir(),'topk-profile-test-'));
 onCleanup(() => rmSync(dir,{ recursive:true, force:true }));
 const profile = path.join(dir,'profile'); const userPrefs = path.join(profile,'user.js');
 mkdirSync(profile); chmodSync(profile,0o777); writeFileSync(userPrefs,'old preferences'); chmodSync(userPrefs,0o666);
 const result = spawnSync(process.execPath,['--import', 'tsx', 'scripts/run-zotero.ts','--dev-dir',dir], {
  env:{ ...process.env, ZOTERO_BIN:'/bin/true', TOPK_API_KEY:'never-provisioned-test-key' }, encoding:'utf8',
 });
 assert.ifError(result.error);
 assert.equal(result.status,0,result.stderr);
 assert.equal(statSync(profile).mode & 0o777,0o700);
 assert.equal(statSync(userPrefs).mode & 0o777,0o600);
 assert.ok(readFileSync(userPrefs,'utf8').includes('never-provisioned-test-key'));
});

test('dev launcher reports signal termination as failure and flushes both output streams', { skip: process.platform === 'win32' }, () => {
 const dir = mkdtempSync(path.join(tmpdir(), 'topk-launch-signal-test-'));
 onCleanup(() => rmSync(dir, { recursive: true, force: true }));
 const executable = path.join(dir, 'zotero-fixture');
 writeFileSync(executable, `#!/bin/sh
 i=0
 while [ "$i" -lt 2048 ]; do
  printf 'buffered output before termination\n'
  i=$((i + 1))
 done
 printf 'last stdout line\n'
 printf 'last stderr line\n' >&2
 kill -TERM "$$"
 `, { mode: 0o700 });
 const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run-zotero.ts', '--dev-dir', dir], {
  env: { ...process.env, ZOTERO_BIN: executable }, encoding: 'utf8',
 });
 assert.ifError(result.error);
 assert.ok(typeof result.status === 'number' && result.status > 0);
 assert.match(result.stdout, /SIGTERM/);
 const log = readFileSync(path.join(dir, 'zotero.log'), 'utf8');
 assert.equal(log.split('buffered output before termination\n').length - 1, 2048);
 assert.ok(log.includes('last stdout line\n'));
 assert.ok(log.includes('last stderr line\n'));
});
