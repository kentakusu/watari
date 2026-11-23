// 通信の記録: 宣言した HTTP の応答と WebSocket のメッセージだけを取り、要求の見出しは取らない。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { Affiliation, type Extension, type SessionWindow } from '../src/watari.ts';
import { searchCaptures, type Capture } from '../src/capture.ts';
import { openState } from '../src/state.ts';

const here = dirname(fileURLToPath(import.meta.url));
const home = process.env.WATARI_TEST_HOME ? join(process.env.WATARI_TEST_HOME, 'capture') : join(here, '..', '.test-home', 'capture');

let server: Server;
let base = '';
let aff: Affiliation;
let win: SessionWindow;
const seen: Capture[] = [];
const authSeenByServer: string[] = [];

const waitFor = async (cond: () => boolean, ms = 10000, what = '条件') => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`${ms}ms 待っても ${what} になりません`);
};

// 小さな WebSocket（文字の枠だけ）
function wsText(sock: Duplex, text: string) {
  const b = Buffer.from(text);
  sock.write(Buffer.concat([Buffer.from([0x81, b.length]), b]));
}
function wsRead(buf: Buffer): string {
  const len = buf[1] & 0x7f;
  const mask = buf.subarray(2, 6);
  return Buffer.from(buf.subarray(6, 6 + len).map((x, i) => x ^ mask[i % 4])).toString();
}

const page = `<!doctype html><meta charset="utf-8"><title>通信の試験</title><body><p id="s">0</p><script>
document.cookie = 'sess=cookie-secret-value';
window.startWorker = () => { new SharedWorker('/worker.js'); };
window.go = async () => {
  const r = await fetch('/api/msgs?n=1', { headers: { Authorization: 'Bearer header-secret-token' } });
  await r.text();
  await fetch('/other');
  const ws = new WebSocket('ws://' + location.host + '/ws');
  ws.onopen = () => ws.send('窓から');
  ws.onmessage = () => { document.getElementById('s').textContent = '1'; };
};
</script></body>`;

const ext: Extension = {
  name: 'tap',
  sites: ['http://127.0.0.1:*/*'],
  watch: [],
  capture: [{ name: 'msgs', url: 'http://127.0.0.1:*/api/*' }, { name: 'sock', url: 'ws://127.0.0.1:*/ws', kinds: ['ws'] }],
  onChange() {},
  onCapture(c, w) {
    seen.push(c);
    if (c.name === 'msgs') w.report({ gaps: 2, note: '番号が 2 つ飛んだ（試し）' });
    w.state.set('seen', (w.state.get<number>('seen') ?? 0) + 1);
  },
};

const eval_ = async (expression: string) => (await win.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, win.sessionId)).result.value;

before(async () => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  mkdirSync(home, { recursive: true });
  server = createServer((req, res) => {
    if (req.url?.startsWith('/api/')) {
      authSeenByServer.push(String(req.headers.authorization ?? ''));
      res.setHeader('content-type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ messages: [{ id: 7, text: '本文のテキスト' }] }));
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/worker.js') {
      // 共有ワーカー: 起きてすぐ WebSocket をつなぎ、つながった瞬間に送る（最初の接続を取れるかを見る）
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      return res.end(`const ws = new WebSocket('ws://' + location.host + '/ws'); ws.onopen = () => ws.send('ワーカーから'); onconnect = () => {};`);
    }
    res.end(req.url === '/other' ? 'ほか' : page);
  });
  server.on('upgrade', (req, sock) => {
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.once('data', (d: Buffer) => { const m = wsRead(d); wsText(sock, m === '窓から' ? 'サーバーから' : `返事:${m}`); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}/`;
  aff = new Affiliation({ name: 'cap', home, headless: true, notifier: async () => {} });
  await aff.start();
  await aff.setExtensions([ext]);
  win = await aff.openWindow('cap/test', base, '通信の試験');
  await waitFor(() => !!win.url && win.url.startsWith(base), 10000, 'ページを開く');
  await new Promise((r) => setTimeout(r, 500));
});

after(async () => {
  await aff?.stop();
  server?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

test('宣言した HTTP の応答を本文ごと取り、宣言していないものは取らない', async () => {
  await eval_('go()');
  await waitFor(() => seen.some((c) => c.name === 'msgs'), 10000, 'HTTP の記録');
  const c = seen.find((x) => x.name === 'msgs')!;
  assert.equal(c.kind, 'http');
  assert.equal(c.method, 'GET');
  assert.equal(c.status, 200);
  assert.match(c.body ?? '', /本文のテキスト/);
  assert.equal(c.session, 'cap/test');
  assert.ok(!seen.some((x) => x.url.includes('/other')), '宣言していない URL まで取っている');
});

test('WebSocket のメッセージを、受けた・送ったの向きつきで取る', async () => {
  await waitFor(() => seen.filter((c) => c.kind === 'ws').length >= 2, 10000, 'WebSocket の記録');
  const ws = seen.filter((c) => c.kind === 'ws');
  assert.deepEqual(ws.map((c) => [c.dir, c.body]).sort(), [['in', 'サーバーから'], ['out', '窓から']]);
});

test('要求の見出し（Authorization・Cookie）は記録に残さない', () => {
  // 対照: 見出しは実際に送られていた（送っていなければ、残っていないことは何も示さない）
  assert.deepEqual(authSeenByServer, ['Bearer header-secret-token']);
  const dir = join(home, 'captures', 'cap');
  const all = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
  assert.ok(all.includes('本文のテキスト'), '記録のファイルに本文が無い（読む場所が違う）');
  assert.ok(!all.includes('header-secret-token'), 'Authorization が記録に残っている');
  assert.ok(!all.includes('cookie-secret-value'), 'Cookie が記録に残っている');
});

test('記録を探せる（名前・含む文字）', () => {
  const r = searchCaptures(home, 'cap', { name: 'msgs', contains: '本文の' });
  assert.equal(r.matched, 1);
  assert.equal(searchCaptures(home, 'cap', { contains: '無い文字' }).matched, 0);
  assert.equal(searchCaptures(home, 'cap', { name: 'sock' }).matched, 2);
});

test('拡張の「取りこぼしたかもしれない数」が窓に積まれる', () => {
  assert.equal(win.gaps, 2);
  assert.match(win.lastReport, /番号が 2 つ飛んだ/);
});

test('共有ワーカーの WebSocket も、起きた直後の最初の送信から取る', async () => {
  await eval_('startWorker()');
  await waitFor(() => seen.filter((c) => c.source === 'shared_worker').length >= 2, 15000, '共有ワーカーの記録');
  const w = seen.filter((c) => c.source === 'shared_worker');
  assert.deepEqual(w.map((c) => [c.dir, c.body]).sort(), [['in', '返事:ワーカーから'], ['out', 'ワーカーから']]);
  assert.ok(w.every((c) => c.workerUrl?.endsWith('/worker.js') && c.session === 'cap/test'));
  // 窓そのものの通信の記録には source: page が付く
  assert.ok(seen.filter((c) => c.name === 'msgs').every((c) => c.source === 'page'));
});

test('拡張の状態は所属と拡張ごとのファイルに残り、読み直せる', () => {
  const fresh = openState(home, 'cap', 'tap'); // 常駐を起こし直したのと同じ（ファイルから読み直す）
  assert.ok((fresh.get<number>('seen') ?? 0) >= 4, JSON.stringify(fresh.all()));
  assert.throws(() => fresh.set('big', 'x'.repeat(1_100_000)), /大きすぎます/);
  assert.equal(fresh.get('big'), undefined, '断った書き込みが残っている');
});

test('拡張を外すと、もう取らない', async () => {
  await aff.setExtensions([]);
  const n = seen.length;
  const before = searchCaptures(home, 'cap', {}).matched;
  await eval_('go()');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(seen.length, n);
  assert.equal(searchCaptures(home, 'cap', {}).matched, before);
});
