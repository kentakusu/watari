// 常駐（daemon）と MCP サーバーを、本物の MCP client から端まで通す。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDaemon } from '../src/daemon.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const home = process.env.WATARI_TEST_HOME ? join(process.env.WATARI_TEST_HOME, 'daemon') : join(root, '.test-home', 'daemon');
const port = 20000 + Math.floor(Math.random() * 20000);
const notes: Array<{ session: string; text: string }> = [];

let site: Server;
let siteUrl = '';
let daemon: Awaited<ReturnType<typeof startDaemon>>;
let mcp: Client;

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 15000, what = '条件') => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`${ms}ms 待っても ${what} になりません`);
};

// 紡の環境変数を持ち込まない（持ち込むと、試験の外のセッション名で動く）
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k, v]) => !k.startsWith('TSUMUGI_') && v !== undefined)) as Record<string, string>;

async function connect(args: string[]): Promise<Client> {
  const c = new Client({ name: 'watari-test', version: '0' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'src', 'mcp.ts'), '--home', home, ...args], env: cleanEnv(), stderr: 'pipe' }));
  return c;
}

const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as any;
const textOf = (r: any) => r.content.map((x: any) => x.text ?? '').join('');

before(async () => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    port,
    // 台帳の試験用: 宛ての発言で test/mcp を起こす（静けさを短く）
    triggers: { test: { notifyTo: 'test/mcp', quietSeconds: 0.2, maxWaitSeconds: 2, rules: [{ name: 'toMe', toMe: true }] } },
    // 送る口の試験用: room-a だけ許し、確かめは 2 秒で打ち切る
    outbox: { test: { allowedStreams: ['room-a'], confirmSeconds: 2 } },
  }));
  const html = readFileSync(join(here, 'fixtures', 'inbox.html'), 'utf8');
  site = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/patrol') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(readFileSync(join(here, 'fixtures', 'patrol.html')));
    }
    if (u.pathname === '/virtual') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(readFileSync(join(here, 'fixtures', 'virtual.html')));
    }
    const arrive = u.searchParams.get('arrive');
    const extra = arrive ? `<script>setTimeout(() => arrive(${JSON.stringify(arrive)}), 1500)</script>` : '';
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html.replace('</body>', `${extra}</body>`));
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  siteUrl = `http://127.0.0.1:${(site.address() as any).port}/`;
  daemon = await startDaemon({ home, headless: true, missingGraceMs: 300, notifyOverride: async (session, text) => { notes.push({ session, text }); } });
  mcp = await connect(['--session', 'test/mcp']);
});

after(async () => {
  await mcp?.close();
  await daemon?.stop();
  site?.close();
  if (!process.env.WATARI_KEEP_TEST_HOME) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

test('口: 合言葉なしでは断る・生死の確認だけは通す', async () => {
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  const noToken = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', body: JSON.stringify({ method: 'status' }) });
  assert.equal(noToken.status, 401);
  const wrong = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify({ method: 'status' }) });
  assert.equal(wrong.status, 401);
});

test('MCP の道具がそろっている', async () => {
  const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
  for (const n of ['open_window', 'window_info', 'read', 'collect', 'click', 'type_text', 'press_key', 'scroll_until', 'screenshot', 'dom_outline', 'set_display', 'set_label', 'list_extensions', 'install_extension', 'remove_extension', 'search_captures', 'recent_log', 'ledger_unread', 'ledger_read', 'ledger_list', 'ledger_search', 'ledger_fires', 'send_message', 'outbox_list', 'watari_status']) {
    assert.ok(names.includes(n), `${n} がありません: ${names.join(',')}`);
  }
});

test('窓を開いて読み・入れ・押し・画像を撮る', async () => {
  const r = await call(mcp, 'open_window', { url: siteUrl, label: '試験の窓' });
  assert.ok(!r.isError, textOf(r));
  // 見張りが立っても、題が付くのは読み込みのあと。題が付くまで待つ
  await waitFor(async () => { const x = await call(mcp, 'window_info'); return !x.isError && !!JSON.parse(textOf(x)).title; }, 15000, '窓の題が付く');
  const info = JSON.parse(textOf(await call(mcp, 'window_info')));
  assert.equal(info.title, '試験用の受信箱');
  assert.equal(info.label, '試験の窓');
  assert.ok(!(await call(mcp, 'type_text', { selector: '#msg', text: 'MCP から' })).isError);
  assert.ok(!(await call(mcp, 'click', { selector: '#send' })).isError);
  assert.deepEqual(JSON.parse(textOf(await call(mcp, 'read', { selector: '#log li' }))), { text: 'MCP から' });
  const shot = await call(mcp, 'screenshot');
  assert.equal(shot.content[0].type, 'image');
  assert.ok(Buffer.from(shot.content[0].data, 'base64').subarray(1, 4).toString() === 'PNG');
});

test('画面の作りを木で読める（テキストは短く切る）', async () => {
  const o = JSON.parse(textOf(await call(mcp, 'dom_outline', { selector: 'h1', text_chars: 2 })));
  assert.equal(o.nodes.tag, 'h1');
  assert.equal(o.nodes.text, '受信…(3)');
  assert.deepEqual(o.nodes.children.map((c: any) => c.id), ['badge']);
  assert.equal(JSON.parse(textOf(await call(mcp, 'dom_outline', { selector: '#nai' }))), null);
});

test('一覧を項目ごとのオブジェクトで読める', async () => {
  const r = JSON.parse(textOf(await call(mcp, 'collect', { selector: 'button', fields: { label: '.', type: '@type', none: '.nai', idOfSelf: '@id' } })));
  assert.deepEqual(r.items, [
    { label: '送る', type: 'button', none: null, idOfSelf: 'send' },
    { label: '既読にする', type: 'button', none: null, idOfSelf: 'mark-read' },
  ]);
  const h = JSON.parse(textOf(await call(mcp, 'collect', { selector: 'h1', fields: { badge: '#badge', badgeId: '#badge@id' } })));
  assert.deepEqual(h.items, [{ badge: '0', badgeId: 'badge' }]);
});

test('無い要素を押すと失敗として返る（黙って成功しない）', async () => {
  const r = await call(mcp, 'click', { selector: '#nai' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /見つかりません/);
});

test('形の違う拡張は入れずに断る', async () => {
  const p = join(home, 'bad-ext.mjs');
  writeFileSync(p, 'export default { name: "bad", sites: [], watch: [], onChange() {} };');
  const r = await call(mcp, 'install_extension', { path: p });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /sites が空/);
  assert.equal(JSON.parse(textOf(await call(mcp, 'list_extensions'))).length, 0);
});

test('拡張を入れると窓で動き、通知はその窓のセッションへ行く', async () => {
  const p = join(root, 'examples', 'badge-watch', 'index.ts');
  const r = await call(mcp, 'install_extension', { path: p });
  assert.ok(!r.isError, textOf(r));
  const rec = JSON.parse(textOf(r));
  assert.equal(rec.installedBy, 'test/mcp');
  assert.equal(rec.affiliation, 'test');
  // 入れたあとに開いた文書で効くことを見る（読み直さずに効くことは e2e の試験で見る）
  await call(mcp, 'open_window', { url: `${siteUrl}?arrive=${encodeURIComponent('拡張から')}` });
  await waitFor(() => notes.some((n) => n.text.includes('最新: 拡張から')), 15000, '拡張の通知');
  assert.equal(notes.find((n) => n.text.includes('最新: 拡張から'))!.session, 'test/mcp');
});

test('拡張を外すと、もう動かない', async () => {
  assert.ok(!(await call(mcp, 'remove_extension', { name: 'badge-watch' })).isError);
  const before = notes.length;
  await call(mcp, 'open_window', { url: `${siteUrl}?arrive=${encodeURIComponent('外したあと')}` });
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(notes.length, before, notes.slice(before).map((n) => n.text).join('\n'));
});

test('セッション名が分からない MCP は、黙らずに失敗を返す', async () => {
  const anon = await connect([]);
  try {
    const r = await call(anon, 'window_info');
    assert.equal(r.isError, true);
    assert.match(textOf(r), /セッションの名前が分かりません/);
  } finally { await anon.close(); }
});

test('状態に所属・窓・拡張が出る', async () => {
  const s = JSON.parse(textOf(await call(mcp, 'watari_status')));
  const a = s.affiliations.find((x: any) => x.name === 'test');
  assert.ok(a?.running);
  assert.deepEqual(a.windows.map((w: any) => w.session), ['test/mcp']);
  assert.deepEqual(a.extensions, []);
  // 置き場はこのユーザーだけに絞られている（記録に他人の発言が入るため）
  assert.equal(s.homeAccess.ok, true, s.homeAccess.detail);
  // 窓は動いたばかりなので古くない。取りこぼしの報告はまだ無い
  assert.equal(a.windows[0].stale, false);
  assert.equal(a.windows[0].gaps, 0);
});

test('記録の失敗だけを読める', async () => {
  const r = JSON.parse(textOf(await call(mcp, 'recent_log', { types: ['window-opened'], limit: 5 })));
  assert.ok(r.items.length > 0 && r.items.every((x: any) => x.type === 'window-opened'));
  const none = JSON.parse(textOf(await call(mcp, 'search_captures', { contains: '無い' })));
  assert.equal(none.matched, 0);
});

test('台帳: 拡張が入れた発言で起こし（本文なし）、MCP で未読を見て・流れと一緒に読み・探せる', async () => {
  const p = join(home, 'ledger-ext.mjs');
  writeFileSync(p, `export default {
    name: 'ledger-ext', sites: ['http://127.0.0.1:*/*'], watch: [{ name: '最新', selector: '#latest' }],
    onChange(e, w) {
      if (!e.value) return;
      w.ledger.put([{ stream: 'room-a', id: 'm-' + e.value, seq: 1, streamName: '試験の部屋', streamKind: 'group', author: 'u-tanaka', authorName: '田中',
        // 最初の 1 件は時刻を少し先にする（「有効にした時刻より前」で起こさないのではなく、「最初の取り込み」で起こさないことを見るため）
        at: new Date(Date.now() + (e.value.includes('最初') ? 5000 : 0)).toISOString(), text: e.value, toMe: e.value.includes('宛て') }]);
    },
  };`);
  // 窓は、前の試験の値（#latest）が残らないページに移してから拡張を入れる（並び順に頼らない）
  await call(mcp, 'open_window', { url: siteUrl });
  await waitFor(async () => { const x = await call(mcp, 'window_info'); return !x.isError && JSON.parse(textOf(x)).url === siteUrl && !!JSON.parse(textOf(x)).title; }, 15000, '空のページ');
  assert.ok(!(await call(mcp, 'install_extension', { path: p })).isError);
  // この所属で最初に台帳に入る発言は、宛てでも「最初の取り込み」とみなして起こさない
  let before = notes.length;
  await call(mcp, 'open_window', { url: `${siteUrl}?arrive=${encodeURIComponent('最初の取り込みの宛ての発言')}` });
  await waitFor(async () => { const r = await call(mcp, 'ledger_list', { stream: 'room-a' }); return !r.isError && JSON.parse(textOf(r)).items.length === 1; }, 15000, '最初の 1 件が台帳に入る');
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(!notes.slice(before).some((n) => n.text.startsWith('trigger id=')), '最初の取り込みで起こした');
  // 次の発言からは起こす
  before = notes.length;
  await call(mcp, 'open_window', { url: `${siteUrl}?arrive=${encodeURIComponent('田中さん宛ての相談です')}` });
  await waitFor(() => notes.slice(before).some((n) => n.text.startsWith('trigger id=')), 15000, '起こす知らせ');
  const fire = notes.slice(before).find((n) => n.text.startsWith('trigger id='))!;
  assert.equal(fire.session, 'test/mcp');
  assert.match(fire.text, /^trigger id=\d+ rules=toMe kind=group count=1 stream=試験の部屋$/);
  assert.ok(!fire.text.includes('相談'), '知らせに本文が入っている');

  const unread = JSON.parse(textOf(await call(mcp, 'ledger_unread', { for_me_only: true })));
  // 最初の取り込みの分も、起こさなかっただけで未読には出る
  assert.deepEqual(unread.items.map((x: any) => x.text).sort(), ['最初の取り込みの宛ての発言', '田中さん宛ての相談です'].sort());
  const found = JSON.parse(textOf(await call(mcp, 'ledger_search', { q: '相談です' })));
  assert.equal(found.items.length, 1);
  let fires = JSON.parse(textOf(await call(mcp, 'ledger_fires')));
  assert.equal(fires.stats.delivered, 1);
  assert.equal(fires.stats.aiUnreadFires, 1);

  // 知らせの 1 行の id だけで、その知らせに入った発言をまとめて読む
  const triggerId = Number(fire.text.match(/trigger id=(\d+)/)![1]);
  const byTrigger = JSON.parse(textOf(await call(mcp, 'ledger_read', { trigger_id: triggerId })));
  assert.equal(byTrigger.trigger.id, triggerId);
  assert.deepEqual(byTrigger.trigger.rules, ['toMe']);
  assert.deepEqual(byTrigger.missing, []);
  assert.equal(byTrigger.reads.length, 1);
  const read = byTrigger.reads[0];
  assert.equal(read.item.text, '田中さん宛ての相談です');
  assert.ok(read.item.aiReadAt);
  const noFire = await call(mcp, 'ledger_read', { trigger_id: 99999 });
  assert.equal(noFire.isError, true);
  assert.match(textOf(noFire), /その知らせはありません/);
  assert.deepEqual(JSON.parse(textOf(await call(mcp, 'ledger_unread', { for_me_only: true }))).items.map((x: any) => x.text), ['最初の取り込みの宛ての発言']);
  fires = JSON.parse(textOf(await call(mcp, 'ledger_fires')));
  assert.equal(fires.stats.aiUnreadFires, 0);
  assert.ok(!(await call(mcp, 'remove_extension', { name: 'ledger-ext' })).isError);
});

test('台帳に入れるとき、設定の identity で書き手を見分ける（拡張は素直に入れるだけ）', async () => {
  const cfgPath = join(home, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, identity: { test: { ownAuthors: ['u-own'], proxyAuthorNames: ['x アシスタント'] } } }));
  const p = join(home, 'identity-ext.mjs');
  writeFileSync(p, `export default {
    name: 'identity-ext', sites: ['http://127.0.0.1:*/*'], watch: [{ name: '最新', selector: '#latest' }],
    onChange(e, w) {
      if (!e.value) return;
      const at = new Date().toISOString();
      w.ledger.put([
        { stream: 'room-id', id: 'own-' + e.value, at, text: 'a', author: 'u-own', authorKind: 'human' },
        { stream: 'room-id', id: 'proxy-' + e.value, at, text: 'b', author: 'b-proxy', authorKind: 'bot', authorName: '田中 x アシスタント' },
        { stream: 'room-id', id: 'bot-' + e.value, at, text: 'c', author: 'b-plain', authorKind: 'bot', authorName: 'お知らせ' },
      ]);
    },
  };`);
  assert.ok(!(await call(mcp, 'install_extension', { path: p })).isError);
  await call(mcp, 'open_window', { url: `${siteUrl}?arrive=${encodeURIComponent('見分け')}` });
  await waitFor(async () => { const r = await call(mcp, 'ledger_list', { stream: 'room-id' }); return !r.isError && JSON.parse(textOf(r)).items.length === 3; }, 15000, '3 件が台帳に入る');
  const items = JSON.parse(textOf(await call(mcp, 'ledger_list', { stream: 'room-id', order: 'asc' }))).items;
  const by = Object.fromEntries(items.map((x: any) => [x.author, [!!x.mine, x.authorKind]]));
  assert.deepEqual(by, { 'u-own': [true, 'human'], 'b-proxy': [false, 'human'], 'b-plain': [false, 'bot'] });
  writeFileSync(cfgPath, JSON.stringify(cfg));
  assert.ok(!(await call(mcp, 'remove_extension', { name: 'identity-ext' })).isError);
});

test('台帳の無い所属を読んでも、台帳のファイルを作らない', async () => {
  const r = await daemon.methods['ledger.search']({ affiliation: 'no-ledger', q: '何か' }).then(() => null, (e: Error) => e.message);
  assert.match(String(r), /まだ台帳がありません/);
  assert.ok(!existsSync(join(home, 'ledger', 'no-ledger.db')), '読んだだけで台帳のファイルができた');
});

test('送る口: 画面で送り、台帳で確かめる（確かめ済み・確かめられない・送れなかった）。関所で断るものは送らない', async () => {
  const p = join(home, 'sender-ext.mjs');
  writeFileSync(p, `export default {
    name: 'sender', sites: ['http://127.0.0.1:*/*'], watch: [],
    onChange() {},
    async onSend(req, w) {
      if (req.text.includes('[失敗]')) throw new Error('送る欄が見つからない（試し）');
      await w.type('#msg', req.text);
      await w.click('#send');
      if (req.text.includes('[確かめない]')) return;
      // 画面に出た自分の発言を台帳に入れる（本物の拡張では、通信や画面から読む）
      const shown = await w.readAll('#log li');
      w.ledger.put([{ stream: req.stream, id: 'sent-' + req.id, at: new Date().toISOString(), text: shown[shown.length - 1], mine: true }]);
    },
  };`);
  assert.ok(!(await call(mcp, 'install_extension', { path: p })).isError);
  await call(mcp, 'open_window', { url: siteUrl });
  // 前の試験で別の URL にいたので、古いページの見張りがまだ生きている。新しいページに移って題が付くまで待つ
  await waitFor(async () => {
    const x = await call(mcp, 'window_info');
    if (x.isError) return false;
    const i = JSON.parse(textOf(x));
    return i.url === siteUrl && !!i.title;
  }, 15000, '新しいページに移って題が付く');
  const logCount = async () => JSON.parse(textOf(await call(mcp, 'collect', { selector: '#log li', fields: { t: '.' } }))).items.length;

  const ok = JSON.parse(textOf(await call(mcp, 'send_message', { stream: 'room-a', text: '送る口の試し' })));
  assert.equal(ok.status, 'confirmed', JSON.stringify(ok));
  assert.equal(ok.by, 'test/mcp');
  const shown = JSON.parse(textOf(await call(mcp, 'collect', { selector: '#log li', fields: { t: '.' } }))).items.map((x: any) => x.t);
  assert.equal(shown.at(-1), '送る口の試し');

  const n = await logCount();
  const again = await call(mcp, 'send_message', { stream: 'room-a', text: '送る口の試し' });
  assert.equal(again.isError, true);
  assert.match(textOf(again), /二重に届くのを防ぐ/);
  const notAllowed = await call(mcp, 'send_message', { stream: 'room-b', text: 'ほかの部屋' });
  assert.equal(notAllowed.isError, true);
  assert.match(textOf(notAllowed), /この部屋には送れません/);
  assert.equal(await logCount(), n, '断ったのに画面で送られている');

  const unconfirmed = JSON.parse(textOf(await call(mcp, 'send_message', { stream: 'room-a', text: '[確かめない] 送れたが入らない' })));
  assert.equal(unconfirmed.status, 'unconfirmed');
  const failed = JSON.parse(textOf(await call(mcp, 'send_message', { stream: 'room-a', text: '[失敗] 送れない' })));
  assert.equal(failed.status, 'failed');
  assert.match(failed.note, /送る欄が見つからない/);

  const list = JSON.parse(textOf(await call(mcp, 'outbox_list')));
  assert.deepEqual([list.counts.confirmed, list.counts.unconfirmed, list.counts.failed], [1, 1, 1]);
  assert.ok(!(await call(mcp, 'remove_extension', { name: 'sender' })).isError);
});

test('巡回: 拡張は一覧の形と最新の番号だけ。未読の部屋を本体が開き、台帳が追いついたら home へ戻す。開いた直後の既読は無視する', async () => {
  const p = join(home, 'patrol-ext.mjs');
  writeFileSync(p, `export default {
    name: 'patrol-ext', sites: ['http://127.0.0.1:*/patrol*'],
    watch: [{ name: '最新', selector: '#latest' }, { name: '開いた', selector: '#opened' }],
    patrol: { rows: '#list .row', key: '@data-id', selected: '.selected', unread: '.unread', home: 'home', settleMs: 3000 },
    onChange(e, w) {
      if (!e.value) return;
      if (e.watch === '最新') { for (const kv of e.value.split(',')) { const [k, v] = kv.split('='); w.ledger.setLatest(k, Number(v)); } return; }
      const [room, n] = e.value.split(':');
      const items = [];
      for (let i = 1; i <= Number(n); i++) items.push({ stream: room, id: room + '-' + i, seq: i, at: new Date().toISOString(), text: room + ' の ' + i });
      if (items.length) w.ledger.put(items);
      // サイトは開くと既読にする（その報告）。巡回で開いた直後なので、本体は持ち主の既読として扱わない
      w.ledger.setOwnerRead(room, Number(n));
    },
  };`);
  assert.ok(!(await call(mcp, 'install_extension', { path: p })).isError);
  await call(mcp, 'open_window', { url: siteUrl + 'patrol' });
  await waitFor(async () => (await call(mcp, 'read', { selector: '#clicks' })).content?.[0]?.text?.includes('home'), 20000, '巡回が A を開いて home へ戻る');
  assert.equal(JSON.parse(textOf(await call(mcp, 'read', { selector: '#clicks' }))).text, 'a,home', 'B（未読でない・大事でない）まで開いた、または順番が違う');
  const a = JSON.parse(textOf(await call(mcp, 'ledger_list', { stream: 'a', order: 'asc' })));
  assert.deepEqual(a.items.map((x: any) => x.seq), [1, 2, 3]);
  const tok = readFileSync(join(home, 'token'), 'utf8').trim();
  const st = await (await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'status' }) })).json() as any;
  const win = st.result.affiliations.find((x: any) => x.name === 'test').windows.find((x: any) => x.session === 'test/mcp');
  assert.equal(win.patrol['patrol-ext'].caughtUp, 1);
  assert.ok(win.patrol['patrol-ext'].ignoredOwnerReads >= 1, '開いた直後の既読を無視していない');
  const logText = readFileSync(join(home, 'log', 'test.jsonl'), 'utf8');
  assert.match(logText, /"type":"patrol-opened","stream":"a"/);
  assert.match(logText, /"type":"owner-read-ignored","stream":"a"/);
  assert.ok(!(await call(mcp, 'remove_extension', { name: 'patrol-ext' })).isError);
});

test('見えている分しか描かない一覧を、目当ての要素が出るまでたどる（末尾では続きの読み込みを待つ）', async () => {
  await call(mcp, 'open_window', { url: `${siteUrl}virtual` });
  // 読み込み中は collect が失敗を返すので、そのあいだは「まだ」とみなす
  await waitFor(async () => {
    const r = await call(mcp, 'collect', { selector: '.item', fields: { id: '@id' } });
    return !r.isError && JSON.parse(textOf(r)).items.length > 0;
  }, 15000, '一覧が描かれる');
  // 対照: たどる前は、奥の要素は無い
  assert.equal(JSON.parse(textOf(await call(mcp, 'read', { selector: '#item-120' }))).text, null);
  const r1 = JSON.parse(textOf(await call(mcp, 'scroll_until', { selector: '#item-120', within: '.item', wait_ms: 50 })));
  assert.equal(r1.found, true);
  assert.ok(r1.steps > 0);
  // 最初に持っていない 250 番は、末尾で続きの読み込みを待って見つける
  const r2 = JSON.parse(textOf(await call(mcp, 'scroll_until', { selector: '#item-250', within: '.item', wait_ms: 50, end_wait_ms: 1500 })));
  assert.equal(r2.found, true, JSON.stringify(r2));
  // 無いものは、末尾に着いたと返す
  const r3 = JSON.parse(textOf(await call(mcp, 'scroll_until', { selector: '#item-999', within: '.item', wait_ms: 50, end_wait_ms: 300, back_to_top: true })));
  assert.deepEqual([r3.found, r3.reachedEnd], [false, true]);
  // 先頭に戻っている
  assert.equal(JSON.parse(textOf(await call(mcp, 'read', { selector: '#item-0' }))).text, '部屋 0');
});

test('拡張の入った窓が閉じられたら黙らずに知らせ、keepOpen の窓は開き直す（Chrome ごと終わっても）', async () => {
  // ほかの試験の窓を巻き込まないよう、別の所属（keep）で試す
  const p = join(home, 'watcher-ext.mjs');
  writeFileSync(p, `export default { name: 'watcher', sites: ['http://127.0.0.1:*/*'], watch: [], notifyTo: 'test/boss', onChange() {} };`);
  await daemon.methods['window.open']({ session: 'keep/closer', url: siteUrl });
  await daemon.methods['extension.install']({ affiliation: 'keep', path: p, by: 'test/mcp' });
  const sessions = async () => ((await daemon.methods.status({})).affiliations.find((x: any) => x.name === 'keep')?.windows ?? []).map((w: any) => w.session);
  const toBoss = () => notes.filter((n) => n.session === 'test/boss').map((n) => n.text);

  // (a) keepOpen に無い窓: 閉じられたら知らせ、開き直さない
  let before = toBoss().length;
  await daemon.methods['window.close']({ session: 'keep/closer' });
  await waitFor(() => toBoss().length > before, 10000, '閉じられた知らせ');
  assert.match(toBoss().at(-1)!, /窓 keep\/closer が閉じられました。.*watcher.*keepOpen/);
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(!(await sessions()).includes('keep/closer'), 'keepOpen に無いのに開き直している');

  // (b) keepOpen の窓: 閉じられたら開き直して知らせる
  const cfgPath = join(home, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, keepOpen: ['keep/keeper'] }));
  await daemon.methods['window.open']({ session: 'keep/keeper', url: siteUrl, label: '残す窓' });
  before = toBoss().length;
  await daemon.methods['window.close']({ session: 'keep/keeper' });
  await waitFor(() => toBoss().slice(before).some((t) => /keep\/keeper が閉じられたので、(最小化で)?開き直しました/.test(t)), 15000, '開き直した知らせ');
  assert.ok((await sessions()).includes('keep/keeper'));

  // (c) Chrome ごと終わっても、keepOpen の窓は Chrome を起こし直して開き直す
  const started = readFileSync(join(home, 'log', 'keep.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'chrome-started');
  before = toBoss().length;
  process.kill(started.at(-1).pid);
  await waitFor(() => toBoss().slice(before).some((t) => /Chrome が終わりました/.test(t)), 15000, 'Chrome が終わった知らせ');
  await waitFor(() => toBoss().slice(before).some((t) => /（Chrome ごと）閉じられたので、(最小化で)?開き直しました/.test(t)), 20000, 'Chrome ごとの開き直し');
  assert.ok((await sessions()).includes('keep/keeper'));

  // (d) 短い間に何度も閉じられたら、開き直すのをやめて知らせる（10 分で 3 回まで。(b)(c) で 2 回使った）
  before = toBoss().length;
  await daemon.methods['window.close']({ session: 'keep/keeper' });
  await waitFor(() => toBoss().slice(before).some((t) => /開き直しました/.test(t)), 15000, '3 回目の開き直し');
  before = toBoss().length;
  await daemon.methods['window.close']({ session: 'keep/keeper' });
  await waitFor(() => toBoss().slice(before).some((t) => /開き直すのをやめました/.test(t)), 15000, 'やめた知らせ');
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(!(await sessions()).includes('keep/keeper'));

  writeFileSync(cfgPath, JSON.stringify(cfg));
  await daemon.methods['extension.remove']({ affiliation: 'keep', name: 'watcher', by: 'test/mcp' });
  await daemon.methods['affiliation.stop']({ name: 'keep' }); // 人が止めた所属は、知らせも開き直しもしない
});

test('見せ方: keepOpen の窓の閉じるボタンで「裏で動かす」に切り替わり、窓も拡張も戻る。「窓を出す」で戻る', async () => {
  // 試験の Chrome は画面なしに固定しているが、見せ方の記録と切り替え（Chrome の起こし直し・窓の開き直し）は同じ道を通る
  const cfgPath = join(home, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, keepOpen: ['disp/main'] }));
  const p = join(home, 'disp-ext.mjs');
  writeFileSync(p, `export default { name: 'disp-ext', sites: ['http://127.0.0.1:*/*'], watch: [], onChange() {} };`);
  await daemon.methods['window.open']({ session: 'disp/main', url: siteUrl });
  await daemon.methods['extension.install']({ affiliation: 'disp', path: p, by: 'test/mcp' });
  const logOf = () => readFileSync(join(home, 'log', 'disp.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  await waitFor(() => logOf().some((r) => r.type === 'close-guard-armed'), 15000, '閉じるボタンの仕掛けが入る');
  const statusOf = async () => (await daemon.methods.status({})).affiliations.find((x: any) => x.name === 'disp');
  assert.equal((await statusOf()).display, 'visible');

  // 閉じるボタンと同じ閉じ方（閉じるときの問いを通る）
  const w = daemon.affiliation('disp')!.windows.get('disp/main')!;
  await w.cdp.send('Page.close', {}, w.sessionId).catch(() => {});
  await waitFor(() => logOf().some((r) => r.type === 'display-switched' && r.display === 'hidden'), 30000, '裏で動かすへの切り替え');
  let s = await statusOf();
  assert.equal(s.display, 'hidden');
  assert.deepEqual(s.windows.map((x: any) => x.session), ['disp/main']);
  assert.deepEqual(s.extensions, ['disp-ext']);
  assert.equal(JSON.parse(readFileSync(join(home, 'display.json'), 'utf8')).disp, 'hidden');

  // 窓を出す
  const r = await daemon.methods['affiliation.display']({ name: 'disp', display: 'visible', by: '試験' });
  assert.deepEqual([r.display, r.changed, r.windows], ['visible', true, ['disp/main']]);
  s = await statusOf();
  assert.equal(s.display, 'visible');
  assert.deepEqual(s.windows.map((x: any) => x.session), ['disp/main']);
  // 同じ見せ方をもう一度選んでも、起こし直さない
  assert.equal((await daemon.methods['affiliation.display']({ name: 'disp', display: 'visible' })).changed, false);
  await assert.rejects(daemon.methods['affiliation.display']({ name: 'disp', display: 'half' }), /'hidden'.*'visible'/);

  writeFileSync(cfgPath, JSON.stringify(cfg));
  await daemon.methods['affiliation.stop']({ name: 'disp' });
});

test('台帳に無い発言を読もうとすると、黙らずに失敗を返す', async () => {
  const r = await call(mcp, 'ledger_read', { stream: 'room-a', id: 'nai' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /台帳にその発言はありません/);
});

test('常駐を起こし直すと、開いていた窓が開き直される', async () => {
  await daemon.stop();
  daemon = await startDaemon({ home, headless: true, missingGraceMs: 300, notifyOverride: async (session, text) => { notes.push({ session, text }); } });
  const s = JSON.parse(textOf(await call(mcp, 'watari_status')));
  assert.deepEqual(s.restoreErrors, []);
  const a = s.affiliations.find((x: any) => x.name === 'test');
  assert.deepEqual(a?.windows.map((w: any) => [w.session, w.label]), [['test/mcp', '試験の窓']]);
  await waitFor(async () => { const x = await call(mcp, 'window_info'); return !x.isError && !!JSON.parse(textOf(x)).title; }, 15000, '開き直した窓の題が付く');
  // 止める直前にいたページ（その前の試験で移った一覧のページ）が開き直される
  assert.equal(JSON.parse(textOf(await call(mcp, 'window_info'))).title, '見えている分しか描かない一覧');
});

test('人が所属を止めたら、その窓は次から開き直さない', async () => {
  await daemon.methods['affiliation.stop']({ name: 'test' });
  await daemon.stop();
  daemon = await startDaemon({ home, headless: true, missingGraceMs: 300, notifyOverride: async () => {} });
  const s = JSON.parse(textOf(await call(mcp, 'watari_status')));
  assert.deepEqual(s.affiliations, []);
});
