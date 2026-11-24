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
    rules: [{ name: 'toMe', toMe: true }, { name: 'urgent', keywords: ['至急'] }, { name: 'direct', streamKinds: ['direct'] }, { name: 'sato', authors: ['佐藤'] }],
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

test('知らせの 1 行の頭と尾に、所属ごとの固定の文を付けられる（改行は空白にして 1 行を保つ）', async () => {
  cfg.linePrefix = '【渡の発火】';
  cfg.lineSuffix = '／ ledger_read で読む\n次の行';
  put([item({ toMe: true, text: '本文' })]);
  await sleep(400);
  assert.equal(sent.length, 1);
  assert.match(sent[0].line, /^【渡の発火】 trigger id=\d+ rules=toMe kind=group count=1 stream=営業 ／ ledger_read で読む 次の行$/);
  assert.ok(!sent[0].line.includes('\n'));
});

test('起こし直しても「有効にした時刻」を引き継ぎ、起こし直している間に来た発言でも起こす', async () => {
  // 1 回目: 起こす条件を使い始める（有効にした時刻が台帳に残る）
  put([item({ stream: 'w0', toMe: true })]);
  await sleep(400);
  const firstCount = sent.length;
  // 常駐の起こし直しの代わり: 作り直す。そのあいだに来た発言（作り直す前の時刻）を、作り直したあとに入れる
  E.stop();
  const during = new Date().toISOString();
  await sleep(50);
  E = new TriggerEngine({ db: L.db, config: () => cfg, send: async (to, line) => { sent.push({ to, line }); }, log: () => {}, ownerRead: (s) => L.ownerReadSeq(s) });
  put([item({ stream: 'w1', toMe: true, at: during })]);
  await sleep(400);
  assert.equal(sent.length, firstCount + 1, '起こし直している間の発言で起こさなかった（有効にした時刻が作り直した時刻になっている）');
});

test('どの条件にも当たらない発言では起こさない', async () => {
  put([item()]);
  await sleep(400);
  assert.equal(sent.length, 0);
});

test('キーワード・部屋の種類・書き手の名前（部分一致）で起こす', async () => {
  put([item({ stream: 's1', text: '至急お願いします' }), item({ stream: 's2', streamKind: 'direct' }), item({ stream: 's3', authorName: '佐藤 一郎' })]);
  await sleep(400);
  assert.deepEqual(sent.map((s) => s.line.match(/rules=(\S+)/)![1]).sort(), ['direct', 'sato', 'urgent']);
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

test('書き手の種類: 所属全体の既定で Bot を起こさない（名指しの部屋でも）。分からない書き手は通す', async () => {
  cfg.authorKinds = ['human'];
  put([item({ stream: 'b1', streamName: 'Bot宛て', toMe: true, authorKind: 'bot' }), item({ stream: 'boss', streamName: '名指しのBot', authorKind: 'bot' })]);
  put([item({ stream: 'b2', streamName: '人', toMe: true, authorKind: 'human' }), item({ stream: 'b3', streamName: '分からない', toMe: true })]);
  await sleep(400);
  assert.deepEqual(sent.map((s) => s.line.match(/stream=(\S+)/)![1]).sort(), ['人', '分からない'], sent.map((s) => s.line).join('\n'));
});

test('規則に書き手の種類を書くと、所属全体の既定より規則の指定を使う。持ち主の側の発言には全体の既定を当てる', async () => {
  cfg.authorKinds = ['human'];
  cfg.rules = [{ name: 'mention', toMe: true, authorKinds: ['human', 'bot'] }, { name: 'urgent', keywords: ['至急'] }];
  put([
    item({ stream: 'k1', streamName: 'ほかの人のBotのメンション', toMe: true, authorKind: 'bot' }),  // 規則の指定で起こす
    item({ stream: 'k2', streamName: 'Botの至急', text: '至急', authorKind: 'bot' }),                 // 規則に指定なし → 全体の既定で弾く
    item({ stream: 'me-dm', streamName: '自分の1:1の自分のBot', toMe: true, authorKind: 'bot', mine: true }), // 持ち主の側の Bot → 全体の既定で弾く（self も mention も）
    item({ stream: 'k3', streamName: '人の至急', text: '至急', authorKind: 'human' }),
  ]);
  await sleep(400);
  assert.deepEqual(sent.map((s) => s.line.match(/stream=(\S+)/)![1]).sort(), ['ほかの人のBotのメンション', '人の至急'].sort(), sent.map((s) => s.line).join('\n'));
});

test('条件の書き手の種類: その種類の発言だけに当たる', async () => {
  cfg.rules = [{ name: 'botAlert', authorKinds: ['bot'], keywords: ['障害'] }];
  put([item({ stream: 'c1', authorKind: 'bot', text: '障害が起きました' }), item({ stream: 'c2', authorKind: 'human', text: '障害の話' })]);
  await sleep(400);
  assert.deepEqual(sent.map((s) => s.line.match(/rules=(\S+)/)![1]), ['botAlert']);
});

test('持ち主が直近に話した部屋の発言で起こす（会話の続き）', async () => {
  cfg.rules = [{ name: 'spoke', spokeRecentlyHours: 2 }];
  put([item({ stream: 'talk', mine: true, at: new Date(Date.now() - 30 * 60000).toISOString() })]);
  put([item({ stream: 'talk', text: '返事です' }), item({ stream: 'other', text: '別の部屋' })]);
  await sleep(400);
  assert.equal(sent.length, 1, sent.map((s) => s.line).join('\n'));
  assert.match(sent[0].line, /rules=spoke/);
});

test('持ち主が話したのが 2 時間より前なら、会話の続きとしては起こさない', async () => {
  cfg.rules = [{ name: 'spoke', spokeRecentlyHours: 2 }];
  cfg.maxAgeMinutes = 600;
  put([item({ stream: 'talk', mine: true, at: new Date(Date.now() - 3 * 3600_000).toISOString() })]);
  put([item({ stream: 'talk', text: '返事です' })]);
  await sleep(400);
  assert.equal(sent.length, 0);
});

test('自分の 1:1 は静けさを待たずに出す', async () => {
  cfg.quietSeconds = 5; // ほかの部屋は 5 秒待つ設定
  const t0 = Date.now();
  put([item({ stream: 'me-dm', text: 'Claude さん、これお願い' })]);
  put([item({ stream: 'g9', toMe: true })]);
  await sleep(150);
  assert.deepEqual(sent.map((s) => s.line.match(/rules=(\S+)/)![1]), ['self'], '自分の 1:1 が待たされている');
  assert.ok(Date.now() - t0 < 1000);
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
