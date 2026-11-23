// 発言の台帳（Chrome を使わない）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger, type LedgerItemInput } from '../src/ledger.ts';

const here = dirname(fileURLToPath(import.meta.url));
let home = '';
let L: Ledger;

const msg = (seq: number, extra: Partial<LedgerItemInput> = {}): LedgerItemInput => ({
  stream: 'room-1', id: `m${seq}`, seq, streamKind: 'group', streamName: '営業の部屋', author: 'u-tanaka', authorKind: 'human', authorName: '田中',
  at: `2026-11-23T0${Math.min(seq, 9)}:00:00Z`, text: `発言 ${seq} 本日の打ち合わせは午後です`, ...extra,
});

before(() => { home = mkdtempSync(join(here, '..', '.test-home-ledger-')); L = new Ledger(home, 'a'); });
after(() => { L.close(); rmSync(home, { recursive: true, force: true }); });

test('新しい発言だけを返し、同じものをもう一度入れても返さない', () => {
  const r1 = L.put([msg(1), msg(2)]);
  assert.deepEqual(r1.added.map((x) => x.id), ['m1', 'm2']);
  const r2 = L.put([msg(1), msg(2)]);
  assert.equal(r2.added.length, 0);
  assert.equal(r2.unchanged, 2);
});

test('同じ id でも中身が変わったら（取り消し・編集）更新として返す', () => {
  const firstSeen = L.get('room-1', 'm2')!.firstSeenAt;
  const r = L.put([msg(2, { recalled: true, text: '' })]);
  assert.deepEqual(r.updated.map((x) => [x.id, x.recalled]), [['m2', true]]);
  assert.equal(r.added.length, 0);
  assert.equal(L.get('room-1', 'm2')!.firstSeenAt, firstSeen, '更新で「最初に見た時刻」が変わった');
});

test('番号の歯抜けを数える', () => {
  L.put([msg(5)]);
  assert.deepEqual(L.gaps('room-1'), [{ stream: 'room-1', missing: 2, firstMissing: 3 }]);
  L.put([msg(3), msg(4)]);
  assert.deepEqual(L.gaps('room-1'), []);
});

test('日本語の全文検索: 3 文字以上は trigram、2 文字以下も探せる、記号はそのまま文字として扱う', () => {
  L.put([{ stream: 'room-2', id: 'x1', at: '2026-11-23T10:00:00Z', text: '見積書を 50% 引きで_送ります', streamName: '取引先' }]);
  assert.deepEqual(L.search('打ち合わせ').map((x) => x.id).sort(), ['m1', 'm3', 'm4', 'm5']);
  assert.deepEqual(L.search('見積').map((x) => x.id), ['x1']);
  assert.deepEqual(L.search('50%').map((x) => x.id), ['x1']);
  assert.deepEqual(L.search('%').map((x) => x.id), ['x1'], '% が何にでも当たる記号として扱われている');
  assert.deepEqual(L.search('取引先').map((x) => x.id), ['x1'], '部屋の名前でも探せる');
  assert.deepEqual(L.search('無い言葉です'), []);
});

test('1 件を前の流れと一緒に読み、AI が読んだ印を付ける。読んだものは未読に出ない', () => {
  assert.ok(L.unread().some((x) => x.id === 'm4'));
  const r = L.read('room-1', 'm4', 2)!;
  assert.deepEqual(r.before.map((x) => x.id), ['m2', 'm3']);
  assert.equal(r.contextGap, false);
  assert.ok(r.item.aiReadAt);
  assert.ok(!L.unread().some((x) => x.id === 'm4'));
});

test('前の流れに番号の抜けがあれば「流れが欠けている」印を立てる', () => {
  L.put([msg(8), msg(10)]);
  assert.equal(L.read('room-1', 'm10', 1)!.contextGap, true);
});

test('宛ての未読だけに絞れる（宛先・返信・全員宛て・自分の 1:1）', () => {
  L.put([
    { stream: 'room-3', id: 'p1', at: '2026-11-23T11:00:00Z', text: '宛先なし' },
    { stream: 'room-3', id: 'p2', at: '2026-11-23T11:01:00Z', text: '宛て', toMe: true },
    { stream: 'room-3', id: 'p3', at: '2026-11-23T11:02:00Z', text: '返信', replyToMe: true },
    { stream: 'me-dm', id: 'p4', at: '2026-11-23T11:03:00Z', text: '自分の 1:1' },
    { stream: 'room-3', id: 'p5', at: '2026-11-23T11:04:00Z', text: '自分の発言', mine: true, toMe: true },
  ]);
  const ids = L.unread({ forMeOnly: true, selfStreams: ['me-dm'] }).map((x) => x.id).sort();
  assert.deepEqual(ids, ['p2', 'p3', 'p4']);
});

test('持ち主がどこまで読んだかは、大きいほうだけを残す', () => {
  L.setOwnerRead('room-1', 5);
  L.setOwnerRead('room-1', 3);
  assert.equal(L.ownerReadSeq('room-1'), 5);
});

test('消したあとに同じ発言を取り直しても、新しいものとして返さない', () => {
  L.put([{ stream: 'old', id: 'o1', at: '2026-11-01T00:00:00Z', text: 'むかしの発言' }]);
  assert.equal(L.prune(7, new Date('2026-11-23T12:00:00Z')) > 0, true);
  assert.equal(L.get('old', 'o1'), undefined);
  assert.deepEqual(L.search('むかしの'), [], '消した発言が検索に残っている');
  const r = L.put([{ stream: 'old', id: 'o1', at: '2026-11-01T00:00:00Z', text: 'むかしの発言' }]);
  assert.equal(r.added.length, 0);
  assert.equal(r.seenBefore, 1);
});

test('形の違う発言は、1 件も入れずに断る', () => {
  const before = L.unread({ limit: 500 }).length;
  assert.throws(() => L.put([{ stream: 'z', id: 'ok', at: '2026-11-23T00:00:00Z' }, { stream: 'z', id: '', at: 'x' } as any]), /id が要ります/);
  assert.equal(L.get('z', 'ok'), undefined, '断ったのに一部が入っている');
  assert.equal(L.unread({ limit: 500 }).length, before);
});
