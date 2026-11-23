// 起こす条件（Chrome を使わない）
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger, type LedgerItemInput } from '../src/ledger.ts';
import { TriggerEngine, type TriggerConfig } from '../src/triggers.ts';

const here = dirname(fileURLToPath(import.meta.url));
let home = '';
let L: Ledger;
let E: TriggerEngine;
let sent: Array<{ to: string; line: string }>;
let cfg: TriggerConfig;
let failSend = false;

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const item = (x: Partial<LedgerItemInput> = {}): LedgerItemInput => ({ stream: 'g1', id: `i${++n}`, streamKind: 'group', streamName: '営業', at: now(), text: '普通の発言', author: 'u1', authorName: '田中', ...x });
const put = (xs: LedgerItemInput[], opt: { initial?: boolean } = {}) => { const r = L.put(xs); E.consider(r.added, opt); return r; };

beforeEach(() => {
  home = mkdtempSync(join(here, '..', '.test-home-trig-'));
  L = new Ledger(home, 'a');
  sent = [];
  failSend = false;
  cfg = {
    notifyTo: 'a/main', quietSeconds: 0.2, maxWaitSeconds: 2, hourlyLimit: 30,
    selfStreams: ['me-dm'], namedStreams: ['boss'],
    rules: [{ name: 'toMe', toMe: true }, { name: 'urgent', keywords: ['至急'] }, { name: 'direct', streamKinds: ['direct'] }, { name: 'suzuki', authors: ['鈴木'] }],
  };
  E = new TriggerEngine({ db: L.db, config: () => cfg, send: async (to, line) => { if (failSend) throw new Error('届かない'); sent.push({ to, line }); }, log: () => {}, ownerRead: (s) => L.ownerReadSeq(s) });
});
afterEach(() => { E.stop(); L.close(); rmSync(home, { recursive: true, force: true }); });

test('条件に当たった発言で、本文を含まない 1 行を知らせる', async () => {
  put([item({ toMe: true, text: '秘密の本文' })]);
  await sleep(400);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'a/main');
  assert.match(sent[0].line, /^trigger id=\d+ rules=toMe kind=group count=1 stream=営業$/);
  assert.ok(!sent[0].line.includes('秘密'), '本文が知らせに入っている');
});

test('どの条件にも当たらない発言では起こさない', async () => {
  put([item()]);
  await sleep(400);
  assert.equal(sent.length, 0);
});

test('キーワード・部屋の種類・書き手の名前（部分一致）で起こす', async () => {
  put([item({ stream: 's1', text: '至急お願いします' }), item({ stream: 's2', streamKind: 'direct' }), item({ stream: 's3', authorName: '鈴木 健太' })]);
  await sleep(400);
  assert.deepEqual(sent.map((s) => s.line.match(/rules=(\S+)/)![1]).sort(), ['direct', 'suzuki', 'urgent']);
});

test('同じ部屋の続けての発言は 1 つにまとめる（静かになってから）', async () => {
  put([item({ toMe: true })]);
  await sleep(100);
  put([item({ text: '至急' })]);
  await sleep(100);
  put([item({ toMe: true })]);
  await sleep(400);
  assert.equal(sent.length, 1);
  assert.match(sent[0].line, /count=3/);
  assert.match(sent[0].line, /rules=toMe,urgent/);
});

test('自分の発言では起こさない。ただし自分の 1:1 では起こす', async () => {
  put([item({ toMe: true, mine: true }), item({ stream: 'me-dm', mine: true })]);
  await sleep(400);
  assert.deepEqual(sent.map((s) => s.line.match(/rules=(\S+)/)![1]), ['self']);
});

test('有効にする前の発言・古すぎる発言・最初の一括取り込みでは起こさない', async () => {
  cfg.enabledAt = new Date(Date.now() - 60000).toISOString();
  put([item({ toMe: true, at: new Date(Date.now() - 120000).toISOString() })]);
  cfg.enabledAt = undefined;
  cfg.maxAgeMinutes = 1;
  put([item({ stream: 'g2', toMe: true, at: new Date(Date.now() - 5 * 60000).toISOString() })]);
  put([item({ stream: 'g3', toMe: true })], { initial: true });
  await sleep(400);
  assert.equal(sent.length, 0, sent.map((s) => s.line).join('\n'));
});

test('持ち主が先に読んだ発言では起こさない。ただし名指しの部屋では起こす', async () => {
  L.setOwnerRead('g1', 10);
  L.setOwnerRead('boss', 10);
  put([item({ seq: 9, toMe: true }), item({ stream: 'boss', seq: 9 })]);
  await sleep(400);
  assert.deepEqual(sent.map((s) => s.line.match(/rules=(\S+)/)![1]), ['named']);
});

test('1 時間の上限を超えた分は「まとめ」1 件に畳む。自分の 1:1 は上限の外', async () => {
  cfg.hourlyLimit = 1;
  put([item({ stream: 'x1', toMe: true })]);
  await sleep(400);
  put([item({ stream: 'x2', toMe: true }), item({ stream: 'x3', text: '至急' })]);
  put([item({ stream: 'me-dm' })]);
  await sleep(400);
  assert.equal(sent.length, 2, sent.map((s) => s.line).join('\n'));
  assert.match(sent[1].line, /rules=self/);
  cfg.hourlyLimit = 10;
  await E.flushOverflow();
  assert.equal(sent.length, 3);
  assert.match(sent[2].line, /kind=summary count=2 stream=2 部屋/);
});

test('届かなかった数・AI がまだ読んでいない発火の数が状態に出る', async () => {
  put([item({ stream: 'r1', toMe: true })]);
  await sleep(400);
  failSend = true;
  put([item({ stream: 'r2', toMe: true })]);
  await sleep(400);
  let s = E.stats();
  assert.equal(s.delivered, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.aiUnreadFires, 1);
  assert.ok(s.oldestAiUnreadFireAt);
  const fired = E.recentFires().find((f) => f.stream === 'r1')!;
  L.read(fired.items[0].stream, fired.items[0].id);
  s = E.stats();
  assert.equal(s.aiUnreadFires, 0);
});
