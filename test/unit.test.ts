// 小さな部品の試験（Chrome を使わない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { pruneCaptures } from '../src/capture.ts';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathForDaemon } from '../src/paths.ts';
import { configuredNotifier } from '../src/notify.ts';

const here = dirname(fileURLToPath(import.meta.url));

test('WSL の /mnt/d/... は Windows の D:\\... に直す', () => {
  assert.equal(pathForDaemon('/mnt/d/watari/ext/index.ts', true), 'D:\\watari\\ext\\index.ts');
  assert.equal(pathForDaemon('/mnt/c', true), 'C:\\');
});

test('WSL の中だけにある場所は断る（Windows の常駐から読めないので）', () => {
  assert.throws(() => pathForDaemon('/home/me/ext.ts', true), /WSL の中だけにある場所/);
});

test('WSL の外では道のりをそのまま渡す', () => {
  assert.equal(pathForDaemon('D:\\x\\y.ts', false), 'D:\\x\\y.ts');
});

test('通知は所属ごとのコマンドへ、無ければ "*" へ行き、本文は標準入力で渡る', async () => {
  const dir = mkdtempSync(join(here, '..', '.test-home-notify-'));
  try {
    // 本文を、所属と名前を名前にしたファイルへ書くだけのコマンド
    const writer = (tag: string) => [process.execPath, '-e', `require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0, 'utf8'))`, join(dir, `${tag}-{affiliation}-{name}.txt`)];
    const n = configuredNotifier({ reatex: writer('r'), '*': writer('other') });
    await n('reatex/reatex-main', '行1\n「記号」$HOME');
    await n('kenta/watari-windows', 'ほか');
    assert.equal(readFileSync(join(dir, 'r-reatex-reatex-main.txt'), 'utf8'), '行1\n「記号」$HOME');
    assert.equal(readFileSync(join(dir, 'other-kenta-watari-windows.txt'), 'utf8'), 'ほか');
    assert.ok(!existsSync(join(dir, 'other-reatex-reatex-main.txt')), 'reatex の通知が "*" にも行っている');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('通信の記録は保持の日数より古い日のファイルだけを消し、日数が無ければ消さない', () => {
  const home = mkdtempSync(join(here, '..', '.test-home-prune-'));
  try {
    const dir = join(home, 'captures', 'a');
    mkdirSync(dir, { recursive: true });
    for (const d of ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23']) writeFileSync(join(dir, `${d}.jsonl`), '{}\n');
    writeFileSync(join(dir, 'メモ.txt'), '日付でないファイルは触らない');
    const now = new Date('2026-11-23T12:00:00Z');
    assert.deepEqual(pruneCaptures(home, 'a', undefined, now), []);
    assert.deepEqual(pruneCaptures(home, 'a', 0, now), []);
    // 2 日残す＝今日と昨日
    assert.deepEqual(pruneCaptures(home, 'a', 2, now).sort(), ['2026-11-20.jsonl', '2026-11-21.jsonl']);
    assert.deepEqual(readdirSync(dir).sort(), ['2026-11-22.jsonl', '2026-11-23.jsonl', 'メモ.txt']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('通知のコマンドが失敗したら、黙らずに失敗を返す', async () => {
  const n = configuredNotifier([process.execPath, '-e', 'process.stderr.write("だめ"); process.exit(3)']);
  await assert.rejects(n('a/b', 'x'), /3 で終わりました: だめ/);
});
