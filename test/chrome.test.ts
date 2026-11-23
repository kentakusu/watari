// 同じプロファイルに Chrome が残っているときの起こし方。
// 渡が落ちると、その Chrome はパイプが切れて自分から終わる（実測: 2 秒以内に 0 本）。
// 終わりきる前に起こし直すと、残っている Chrome に手渡しされて新しい方がすぐ終わるので、渡は少し待つ。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromesOnProfile, findChrome, isBrowserProcess, launchChrome } from '../src/chrome.ts';

const here = dirname(fileURLToPath(import.meta.url));
const base = process.env.WATARI_TEST_HOME ? join(process.env.WATARI_TEST_HOME, 'chrome') : join(here, '..', '.test-home', 'chrome');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const killAll = (dir: string) => { for (const p of chromesOnProfile(dir)) { try { process.kill(p.pid); } catch {} } };

const dirs: string[] = [];
after(async () => {
  // 止めた Chrome がファイルを離すまで待ってから消す（すぐ消すと EPERM になることがあった）
  for (const d of dirs) killAll(d);
  const end = Date.now() + 15000;
  while (dirs.some((d) => chromesOnProfile(d).length) && Date.now() < end) { for (const d of dirs) killAll(d); await sleep(500); }
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

test('渡が落ちた直後に起こし直しても、起きる', async () => {
  const dir = join(base, 'orphan');
  dirs.push(dir);
  const owner = spawn(process.execPath, [join(here, 'fixtures', 'owner.ts'), dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((r) => owner.stdout!.on('data', (d) => { if (String(d).includes('READY')) r(); }));
  owner.kill(); // 落ちた渡の代わり
  await new Promise((r) => owner.once('exit', r));
  const b = await launchChrome({ profileDir: dir, headless: true });
  try {
    assert.ok((await b.cdp.send('Browser.getVersion')).product);
  } finally { await b.close(); }
});

test('人が普通に開いた Chrome は片付けず、名指しで失敗する', async () => {
  const dir = join(base, 'human');
  dirs.push(dir);
  // わざと / 区切りで渡す（Windows では \ と混ざっても同じ場所と分かること）
  const human = spawn(findChrome(), [`--user-data-dir=${dir.replaceAll('\\', '/')}`, '--headless=new', '--no-first-run', 'about:blank'], { stdio: 'ignore', detached: true });
  human.unref();
  const end = Date.now() + 10000;
  while (!chromesOnProfile(dir).some(isBrowserProcess) && Date.now() < end) await sleep(300);
  const pids = chromesOnProfile(dir).filter(isBrowserProcess).map((p) => p.pid);
  assert.ok(pids.length > 0, '人の Chrome が起きていない（試験の前提が成り立っていない）');
  await assert.rejects(launchChrome({ profileDir: dir, headless: true }), /別の Chrome が開いています/);
  const still = chromesOnProfile(dir).filter(isBrowserProcess).map((p) => p.pid);
  assert.ok(pids.every((p) => still.includes(p)), '人の Chrome を止めてしまった');
});
