// 閉じるボタンを押されても閉じずに裏で動かす（keepOpen の窓）。本物の Chrome（headless）で試す。
// 人が閉じるボタンを押すのと同じく、閉じるときの問い（beforeunload）を通る Page.close で閉じようとする。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Affiliation, type SessionWindow } from '../src/watari.ts';

const here = dirname(fileURLToPath(import.meta.url));
const home = process.env.WATARI_TEST_HOME ? join(process.env.WATARI_TEST_HOME, 'close') : join(here, '..', '.test-home', 'close');

let server: Server;
let url = '';
let loads = 0;
let aff: Affiliation;
let guarded: SessionWindow;
let plain: SessionWindow;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = async (w: SessionWindow) => (await aff.browser!.cdp.send('Target.getTargets')).targetInfos.some((t: any) => t.targetId === w.targetId);
const readLog = () => readFileSync(join(home, 'log', 'close.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

before(async () => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  mkdirSync(home, { recursive: true });
  server = createServer((_, res) => { loads++; res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><title>閉じる試し</title><p>本文</p>'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as any).port}/`;
  aff = new Affiliation({ name: 'close', home, headless: true, notifier: async () => {}, closeToBackground: (s) => s === 'close/guarded' });
  await aff.start();
  guarded = await aff.openWindow('close/guarded', url);
  plain = await aff.openWindow('close/plain', url);
  // 読み込み → 名札を 1 回押す（人が触った状態にする）まで待つ
  const end = Date.now() + 10000;
  while (!readLog().some((r) => r.type === 'close-guard-armed') && Date.now() < end) await sleep(100);
});

after(async () => {
  await aff?.stop();
  server?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

test('名札を 1 回押して、閉じるときの問いを出せる状態にする（keepOpen の窓だけ）', () => {
  const armed = readLog().filter((r) => r.type === 'close-guard-armed').map((r) => r.session);
  assert.ok(armed.includes('close/guarded'));
  assert.ok(!armed.includes('close/plain'), 'keepOpen でない窓まで押している');
});

test('閉じようとしても閉じず、裏で動き続ける', async () => {
  await guarded.cdp.send('Page.close', {}, guarded.sessionId).catch(() => {});
  await sleep(1500);
  assert.equal(await alive(guarded), true, '閉じてしまった');
  assert.ok(readLog().some((r) => r.type === 'close-to-background' && r.session === 'close/guarded'));
});

test('ページ自身の読み直しは止めない', async () => {
  const before = loads;
  await guarded.cdp.send('Runtime.evaluate', { expression: 'location.reload()' }, guarded.sessionId);
  await sleep(2000);
  assert.ok(loads > before, '読み直しを止めてしまった');
  assert.equal(await alive(guarded), true);
});

test('読み直したあとも、閉じようとして閉じない（読み込みのたびに押し直している）', async () => {
  const end = Date.now() + 5000;
  while (readLog().filter((r) => r.type === 'close-guard-armed').length < 2 && Date.now() < end) await sleep(100);
  await guarded.cdp.send('Page.close', {}, guarded.sessionId).catch(() => {});
  await sleep(1500);
  assert.equal(await alive(guarded), true);
});

test('読み込みの直後に閉じても、読み直しと取り違えずに閉じない', async () => {
  // 見える窓の Chrome で、読み込み直後（1 秒以内）に閉じると「移動中」と取り違えて閉じてしまったことがある
  const armedBefore = readLog().filter((r) => r.type === 'close-guard-armed').length;
  await guarded.cdp.send('Runtime.evaluate', { expression: 'location.reload()' }, guarded.sessionId);
  const end = Date.now() + 5000;
  while (readLog().filter((r) => r.type === 'close-guard-armed').length <= armedBefore && Date.now() < end) await sleep(50);
  await guarded.cdp.send('Page.close', {}, guarded.sessionId).catch(() => {});
  await sleep(1500);
  assert.equal(await alive(guarded), true, '読み込み直後の閉じるを、移動と取り違えた');
});

test('ページの中のリンクで移るのは止めない', async () => {
  const before = loads;
  await guarded.cdp.send('Runtime.evaluate', { expression: `const a = document.createElement('a'); a.href = '/next'; a.id = 'go'; a.textContent = '次へ'; document.body.appendChild(a); a.click();` }, guarded.sessionId);
  await sleep(2000);
  assert.ok(loads > before, 'リンクの移動を止めてしまった');
  assert.match(guarded.url, /\/next$/);
});

test('keepOpen でない窓は、ふつうに閉じる', async () => {
  await plain.cdp.send('Page.close', {}, plain.sessionId).catch(() => {});
  await sleep(1500);
  assert.equal(await alive(plain), false);
});

test('渡が自分で閉じるときは、問いを通らずに閉じる', async () => {
  await guarded.close();
  await sleep(1500);
  assert.equal(await alive(guarded), false);
});
