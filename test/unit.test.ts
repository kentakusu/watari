// 小さな部品の試験（Chrome を使わない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { pruneCaptures } from '../src/capture.ts';
import { perAffiliation } from '../src/home.ts';
import { decodeMqtt, encodeMqttPublish } from '../src/mqtt.ts';
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

test('所属ごとの設定: 数ならどの所属にも、表ならその所属 → "*" の順、無ければ期限なし', () => {
  assert.equal(perAffiliation(30, 'reatex'), 30);
  assert.equal(perAffiliation({ reatex: 30 }, 'reatex'), 30);
  assert.equal(perAffiliation({ reatex: 30 }, 'kenta'), undefined, 'reatex の日数が kenta にも効いている');
  assert.equal(perAffiliation({ reatex: 30, '*': 7 }, 'kenta'), 7);
  assert.equal(perAffiliation({ reatex: 0, '*': 7 }, 'reatex'), 0, '所属に 0 と書いたら "*" より優先する（期限なし）');
  assert.equal(perAffiliation(undefined, 'reatex'), undefined);
});

test('MQTT: 1 つのフレームに入った複数のパケットを開き、PUBLISH の topic と中身（JSON）を取り出す', () => {
  const frame = Buffer.concat([
    encodeMqttPublish('room/42', JSON.stringify({ seq: 7, text: 'こんにちは' })),
    Buffer.from([0xd0, 0x00]), // PINGRESP
    encodeMqttPublish('badge', Buffer.from([0xff, 0x00, 0x01])), // 文字として読めない中身
  ]);
  const ps = decodeMqtt(frame.toString('base64'));
  assert.deepEqual(ps.map((p) => p.typeName), ['PUBLISH', 'PINGRESP', 'PUBLISH']);
  assert.equal(ps[0].topic, 'room/42');
  assert.deepEqual(ps[0].payloadJson, { seq: 7, text: 'こんにちは' });
  assert.equal(ps[2].payloadText, undefined, '読めない中身を文字にしている');
  assert.equal(Buffer.from(ps[2].payload!, 'base64').toString('hex'), 'ff0001');
});

test('MQTT: 長い中身（長さが 2 バイト以上）・QoS 1 の番号・版 5 の properties・途中で切れたもの', () => {
  const big = 'あ'.repeat(100); // 300 バイト（長さの表しが 2 バイトになる）
  assert.equal(decodeMqtt(encodeMqttPublish('t', big))[0].payloadText, big);
  // QoS 1: 0x32・topic "a"・番号 0x0102・中身 "x"
  const q1 = Buffer.from([0x32, 6, 0, 1, 0x61, 0x01, 0x02, 0x78]);
  const p1 = decodeMqtt(q1)[0];
  assert.deepEqual([p1.qos, p1.packetId, p1.payloadText], [1, 0x0102, 'x']);
  // 版 5: topic "a"・properties の長さ 2（中身 2 バイト）・中身 "y"
  const v5 = Buffer.from([0x30, 7, 0, 1, 0x61, 2, 0x01, 0x01, 0x79]);
  assert.equal(decodeMqtt(v5, { version: 5 })[0].payloadText, 'y');
  // 途中で切れたもの
  const cut = encodeMqttPublish('room', 'abcdef').subarray(0, 6);
  assert.deepEqual(decodeMqtt(cut).map((p) => [p.typeName, p.truncated]), [['PUBLISH', true]]);
});

test('通知のコマンドが失敗したら、黙らずに失敗を返す', async () => {
  const n = configuredNotifier([process.execPath, '-e', 'process.stderr.write("だめ"); process.exit(3)']);
  await assert.rejects(n('a/b', 'x'), /3 で終わりました: だめ/);
});
