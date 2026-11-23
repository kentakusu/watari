// 送る口の関所と確かめ（Chrome を使わない）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../src/ledger.ts';
import { Outbox, type OutboxConfig } from '../src/outbox.ts';

const here = dirname(fileURLToPath(import.meta.url));
let home = '';
let L: Ledger;
let O: Outbox;
const cfg: OutboxConfig = { allowedStreams: ['me-dm'], allowedStreamKinds: ['direct'] };

before(() => { home = mkdtempSync(join(here, '..', '.test-home-outbox-')); L = new Ledger(home, 'a'); O = new Outbox(L.db); });
after(() => { L.close(); rmSync(home, { recursive: true, force: true }); });

test('関所: 設定が無い・許していない部屋・空の本文は断る。部屋の種類で許すこともできる', () => {
  assert.match(O.check(undefined, 'me-dm', 'こんにちは', undefined)!, /設定されていません/);
  assert.match(O.check(cfg, 'group-1', 'こんにちは', 'group')!, /この部屋には送れません/);
  assert.match(O.check(cfg, 'me-dm', '   ', undefined)!, /本文が空/);
  assert.equal(O.check(cfg, 'me-dm', 'こんにちは', undefined), null);
  assert.equal(O.check(cfg, 'dm-tanaka', 'こんにちは', 'direct'), null);
});

test('同じ預けは 1 回しか送り始められない', () => {
  const e = O.create('a/claude', 'me-dm', '一度だけ');
  assert.equal(O.claim(e.id), true);
  assert.equal(O.claim(e.id), false);
  assert.equal(O.get(e.id)!.status, 'sending');
});

test('少し前に同じ部屋へ同じ本文を預かっていれば断る（allowRepeat で送り直せる）。失敗したものは数えない', () => {
  assert.match(O.check(cfg, 'me-dm', '一度だけ', undefined)!, /二重に届くのを防ぐ/);
  assert.equal(O.check(cfg, 'me-dm', '一度だけ', undefined, { allowRepeat: true }), null);
  const f = O.create('a/claude', 'me-dm', '失敗した本文');
  O.claim(f.id);
  O.fail(f.id, '画面が無かった');
  assert.equal(O.check(cfg, 'me-dm', '失敗した本文', undefined), null);
});

test('台帳に自分の発言として本文が完全一致で入ったら confirmed。1 文字でも違えば確かめない', () => {
  const e = O.create('a/claude', 'me-dm', '確かめる本文');
  O.claim(e.id);
  const at = new Date().toISOString();
  // 本文が違う・自分の発言でない・部屋が違う
  const near = L.put([
    { stream: 'me-dm', id: 'x1', at, text: '確かめる本文 ', mine: true },
    { stream: 'me-dm', id: 'x2', at, text: '確かめる本文', mine: false },
    { stream: 'other', id: 'x3', at, text: '確かめる本文', mine: true },
  ]);
  assert.deepEqual(O.matchLedger(near.added), []);
  assert.equal(O.get(e.id)!.status, 'sending');
  const ok = L.put([{ stream: 'me-dm', id: 'x4', at, text: '確かめる本文', mine: true }]);
  assert.deepEqual(O.matchLedger(ok.added).map((x) => x.id), [e.id]);
  assert.deepEqual(O.get(e.id)!.confirmedBy, { stream: 'me-dm', id: 'x4' });
});

test('確かめられないのあとで台帳に入れば、confirmed に変わる', () => {
  const e = O.create('a/claude', 'me-dm', 'あとから入る本文');
  O.claim(e.id);
  O.unconfirmed(e.id, '待っても入らなかった');
  assert.equal(O.get(e.id)!.status, 'unconfirmed');
  const r = L.put([{ stream: 'me-dm', id: 'late', at: new Date().toISOString(), text: 'あとから入る本文', mine: true }]);
  O.matchLedger(r.added);
  assert.equal(O.get(e.id)!.status, 'confirmed');
});

test('状態ごとの数を出す', () => {
  const c = O.counts();
  assert.equal(c.failed, 1);
  assert.ok(c.confirmed >= 2);
  assert.equal(c.sending, 1); // 「一度だけ」はまだ確かめていない
});
