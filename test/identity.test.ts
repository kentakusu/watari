// 書き手の見分け（Chrome を使わない）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger, type LedgerItemInput } from '../src/ledger.ts';
import { Identity } from '../src/identity.ts';

const here = dirname(fileURLToPath(import.meta.url));
let home = '';
let L: Ledger;
let I: Identity;
const at = '2026-11-23T10:00:00Z';
const m = (x: Partial<LedgerItemInput>): LedgerItemInput => ({ stream: 'g', id: Math.random().toString(36).slice(2), at, ...x });

before(() => { home = mkdtempSync(join(here, '..', '.test-home-identity-')); L = new Ledger(home, 'a'); I = new Identity(L.db); });
after(() => { L.close(); rmSync(home, { recursive: true, force: true }); });

test('ownAuthors の書き手は持ち主の側（mine）にする', () => {
  const r = I.apply([m({ author: 'u-me', authorKind: 'human' }), m({ author: 'u-other', authorKind: 'human' })], { ownAuthors: ['u-me'] }, []);
  assert.deepEqual(r.items.map((x) => !!x.mine), [true, false]);
});

test('proxyAuthorNames に当たる Bot は人と同じに扱う。当たらない Bot はそのまま', () => {
  const r = I.apply([
    m({ author: 'b1', authorKind: 'bot', authorName: '田中 一郎 x アシスタント' }),
    m({ author: 'b2', authorKind: 'bot', authorName: 'お知らせの Bot' }),
  ], { proxyAuthorNames: ['x アシスタント'] }, []);
  assert.deepEqual(r.items.map((x) => x.authorKind), ['human', 'bot']);
});

test('自分の 1:1 に出てきた Bot を持ち主の側として覚え、ほかの部屋でも mine にする（代理の名前より先に効く）', () => {
  const cfg = { proxyAuthorNames: ['x アシスタント'] };
  const r1 = I.apply([m({ stream: 'me-dm', author: 'my-bot', authorKind: 'bot', authorName: '持ち主 x アシスタント' })], cfg, ['me-dm']);
  assert.deepEqual(r1.learned, ['my-bot']);
  assert.equal(r1.items[0].mine, true);
  // 別の部屋に出てきても、持ち主の側（人と同じには直さない）
  const r2 = I.apply([m({ stream: 'g', author: 'my-bot', authorKind: 'bot', authorName: '持ち主 x アシスタント' })], cfg, ['me-dm']);
  assert.deepEqual([r2.items[0].mine, r2.items[0].authorKind], [true, 'bot']);
  // 覚えたものは台帳に残る（作り直しても忘れない）
  assert.deepEqual(new Identity(L.db).learned(), ['my-bot']);
  // 2 回目は「新しく覚えた」に数えない
  assert.deepEqual(I.apply([m({ stream: 'me-dm', author: 'my-bot', authorKind: 'bot' })], cfg, ['me-dm']).learned, []);
});

test('覚えるのを切れる。人は覚えない', () => {
  const r = I.apply([m({ stream: 'me-dm', author: 'bot-x', authorKind: 'bot' }), m({ stream: 'me-dm', author: 'human-y', authorKind: 'human' })], { learnOwnBotsFromSelfStreams: false }, ['me-dm']);
  assert.deepEqual(r.learned, []);
  const r2 = I.apply([m({ stream: 'me-dm', author: 'human-y', authorKind: 'human' })], {}, ['me-dm']);
  assert.deepEqual(r2.learned, []);
});

test('元の発言は変えない', () => {
  const orig = m({ author: 'u-me', authorKind: 'human' });
  I.apply([orig], { ownAuthors: ['u-me'] }, []);
  assert.equal(orig.mine, undefined);
});
