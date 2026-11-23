// 本物の Chrome（headless）を起こして、見張り → 拡張 → 操作 → 通知 を端まで通す。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Affiliation, type Extension, type SessionWindow } from '../src/watari.ts';
import badgeWatch from '../examples/badge-watch/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
// 既定は作業ツリーの中（.test-home は .gitignore 済み）。C: が小さい機では D: に置ける
const home = process.env.WATARI_TEST_HOME ?? join(here, '..', '.test-home');

let server: Server;
let aff: Affiliation;
let win: SessionWindow;
const notes: string[] = [];
let outsiderCalls = 0;

// 宣言していないサイトの拡張（陰性対照）: 同じ #badge を見張るが、sites が当たらない
const outsider: Extension = {
  name: 'outsider',
  sites: ['http://example.invalid/*'],
  watch: [{ name: 'よその未読', selector: '#badge' }],
  onChange() { outsiderCalls++; },
};

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 10000, what = '条件') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${ms}ms 待っても ${what} になりません`);
};

// ページ自身の世界（main world）で評価する＝サイトのスクリプトの立場
const page = async (expression: string) => {
  const r = await win.cdp.send('Runtime.evaluate', { expression, returnByValue: true }, win.sessionId);
  return r.result.value;
};

before(async () => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const html = readFileSync(join(here, 'fixtures', 'inbox.html'));
  server = createServer((_, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  aff = new Affiliation({ name: 'test', home, headless: true, missingGraceMs: 300, notifier: async (_s, t) => { notes.push(t); } });
  await aff.start();
  await aff.setExtensions([badgeWatch, outsider]);
  win = await aff.openWindow('test/e2e', `http://127.0.0.1:${port}/`, '試験');
  await waitFor(async () => (await page('document.readyState')) === 'complete', 10000, 'ページの読み込み完了');
  await waitFor(async () => (await page('!!document.querySelector("watari-tag")')) === true, 10000, '名札の表示');
});

after(async () => {
  await aff?.stop();
  server?.close();
  if (!process.env.WATARI_KEEP_TEST_HOME) rmSync(home, { recursive: true, force: true });
});

test('バッジに数字が入ると、拡張が読み・入力し・押し・知らせる', async () => {
  await page('arrive("こんにちは")');
  await waitFor(() => notes.some((n) => n.includes('未読 1 件')), 10000, '通知');
  assert.ok(notes.includes('未読 1 件。最新: こんにちは'), notes.join('\n'));
  assert.deepEqual(await page('[...document.querySelectorAll("#log li")].map((x) => x.textContent)'), ['受け取りました']);
  assert.equal(await page('document.getElementById("badge").textContent'), '0');
});

test('ページのスクリプトからは渡が見えない', async () => {
  assert.equal(await page('window.sawWatari'), false);
  assert.equal(await page('typeof globalThis.__watari'), 'undefined');
});

test('宣言していないサイトの拡張は呼ばれず、「見つからない」も出さない', async () => {
  assert.equal(outsiderCalls, 0);
  assert.ok(!notes.some((n) => n.includes('outsider')), notes.join('\n'));
});

test('「今触ってる」の間は操作を待ち、離すと続ける', async () => {
  const before = notes.length;
  win.setTouching(true);
  await page('arrive("二通目")');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(notes.length, before, '触っている間に通知まで進んでしまった');
  assert.equal(await page('document.querySelectorAll("#log li").length'), 1, '触っている間に送ってしまった');
  win.setTouching(false);
  await waitFor(() => notes.length > before, 10000, '離したあとの通知');
  assert.ok(notes.at(-1)!.includes('最新: 二通目'), notes.at(-1));
});

test('見張っている要素が消えたら「見つかりません」と知らせる', async () => {
  await page('document.getElementById("badge").remove()');
  await waitFor(() => notes.some((n) => n.includes('見つかりません')), 10000, '見つからない通知');
  assert.ok(notes.some((n) => n.includes('badge-watch') && n.includes('未読')));
});

test('拡張はページを読み直さずに出し入れできる', async () => {
  // 見つからない試験で #badge を消したので、作り直す（ページは読み直さない）
  await page('const h = document.querySelector("h1"); const b = document.createElement("span"); b.id = "badge"; b.textContent = "0"; h.appendChild(b)');
  const seen: string[] = [];
  const titleWatch: Extension = { name: 'title-watch', sites: ['http://127.0.0.1:*/*'], watch: [{ name: '最新', selector: '#latest' }], onChange(e) { seen.push(String(e.value)); } };
  const navigations = await page('performance.getEntriesByType("navigation").length');
  await aff.setExtensions([titleWatch]);
  await page('document.getElementById("latest").textContent = "差し替えのあと"');
  await waitFor(() => seen.includes('差し替えのあと'), 10000, '入れた拡張が動く');
  // 外した拡張（badge-watch）はもう動かない
  const before = notes.length;
  await page('arrive("外したあと")');
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(notes.length, before, notes.slice(before).join('\n'));
  assert.equal(await page('performance.getEntriesByType("navigation").length'), navigations);
  assert.equal(await page('window.sawWatari'), false, 'ページが読み直されている');
});

test('記録が残る（窓を開いた・見張りの変化・押した・知らせた）', () => {
  const lines = readFileSync(join(home, 'log', 'test.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const types = new Set(lines.map((l) => l.type));
  for (const t of ['chrome-started', 'window-opened', 'page-ready', 'watch', 'type', 'click', 'notify', 'touch', 'waiting-for-human']) {
    assert.ok(types.has(t), `記録に ${t} がありません: ${[...types].join(',')}`);
  }
  assert.ok(readdirSync(join(home, 'profiles')).includes('test'));
});
