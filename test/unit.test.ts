// 小さな部品の試験（Chrome を使わない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { pruneCaptures } from '../src/capture.ts';
import { perAffiliation, keepOpenList } from '../src/home.ts';
import { decodeMqtt, encodeMqttPublish, MqttJoiner } from '../src/mqtt.ts';
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
    const n = configuredNotifier({ 'team-a': writer('r'), '*': writer('other') });
    await n('team-a/team-a-main', '行1\n「記号」$HOME');
    await n('team-b/someone', 'ほか');
    assert.equal(readFileSync(join(dir, 'r-team-a-team-a-main.txt'), 'utf8'), '行1\n「記号」$HOME');
    assert.equal(readFileSync(join(dir, 'other-team-b-someone.txt'), 'utf8'), 'ほか');
    assert.ok(!existsSync(join(dir, 'other-team-a-team-a-main.txt')), 'team-a の通知が "*" にも行っている');
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
  assert.equal(perAffiliation(30, 'team-a'), 30);
  assert.equal(perAffiliation({ 'team-a': 30 }, 'team-a'), 30);
  assert.equal(perAffiliation({ 'team-a': 30 }, 'team-b'), undefined, 'team-a の日数が team-b にも効いている');
  assert.equal(perAffiliation({ 'team-a': 30, '*': 7 }, 'team-b'), 7);
  assert.equal(perAffiliation({ 'team-a': 0, '*': 7 }, 'team-a'), 0, '所属に 0 と書いたら "*" より優先する（期限なし）');
  assert.equal(perAffiliation(undefined, 'team-a'), undefined);
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

// 実際に起きた形: フレームが前のパケットの途中から始まり、topic の長さとして大きな数（23673）を読んでしまう。
// QoS 1（0x32）なので、直す前はそのあとパケット番号を範囲の外で読んで投げていた（直す前のコードで再現を確かめた。QoS 0 だと投げない）
const brokenFrame = Buffer.from([0x32, 0x05, 0x5c, 0x79, 0x61, 0x62, 0x63]);

test('MQTT: 中の長さがパケットを超えていても投げず、malformed を付けてそこで止める', () => {
  let ps: ReturnType<typeof decodeMqtt> = [];
  assert.doesNotThrow(() => { ps = decodeMqtt(brokenFrame); });
  assert.equal(ps.length, 1);
  assert.match(ps[0].malformed ?? '', /topic の長さ（23673）がパケットを超えている/);
  // 種類 0（パケットの頭でないところ）も投げない
  assert.match(decodeMqtt(Buffer.from([0x00, 0x01, 0x02]))[0].malformed ?? '', /種類 0/);
  // ほかの途中で切れる形も投げない（qos の番号・版 5 の properties）
  assert.doesNotThrow(() => decodeMqtt(Buffer.from([0x32, 0x03, 0x00, 0x01, 0x61])));
  assert.doesNotThrow(() => decodeMqtt(Buffer.from([0x30, 0x04, 0x00, 0x01, 0x61, 0x7f]), { version: 5 }));
});

test('MQTT: フレームをまたぐパケットを、接続ごとにつなぎ直して開く', () => {
  const big = encodeMqttPublish('room/9', JSON.stringify({ text: 'い'.repeat(200) }));
  const second = encodeMqttPublish('room/9', '{"text":"次"}');
  const frame1 = big.subarray(0, 100);
  const frame2 = Buffer.concat([big.subarray(100), second]);
  const J = new MqttJoiner();
  assert.deepEqual(J.feed('conn-1', frame1.toString('base64')), [], '切れたものを、つながる前に返している');
  const got = J.feed('conn-1', frame2.toString('base64'));
  assert.deepEqual(got.map((p) => (p.payloadJson as any).text), ['い'.repeat(200), '次']);
  // 別の接続の残りとは混ざらない
  assert.deepEqual(J.feed('conn-2', frame1.toString('base64')), []);
  assert.equal(J.feed('conn-1', second.toString('base64'))[0].payloadText, '{"text":"次"}');
  // つながずに後半だけを開いても投げない
  assert.doesNotThrow(() => decodeMqtt(frame2));
});

test('MQTT: つなぎ直しの残りが上限を超えたら捨てて数える（黙って膨らませない）', () => {
  const J = new MqttJoiner(10);
  const big = encodeMqttPublish('t', 'x'.repeat(100));
  const ps = J.feed('c', big.subarray(0, 50));
  assert.equal(J.dropped, 1);
  assert.equal(ps[0].truncated, true, '捨てたものは truncated として返す');
});

test('keepOpen は配列でも、1 つだけの文字列でも受け付ける（文字列を 1 文字ずつに分けない）', () => {
  assert.deepEqual(keepOpenList(['team-a/x', 'team-b/y']), ['team-a/x', 'team-b/y']);
  assert.deepEqual(keepOpenList('team-a/x'), ['team-a/x']);
  assert.deepEqual(keepOpenList(undefined), []);
  assert.deepEqual(keepOpenList(''), []);
  assert.deepEqual(keepOpenList(['team-a/x', 3, null]), ['team-a/x']);
});

test('通知のコマンドが失敗したら、黙らずに失敗を返す', async () => {
  const n = configuredNotifier([process.execPath, '-e', 'process.stderr.write("だめ"); process.exit(3)']);
  await assert.rejects(n('a/b', 'x'), /3 で終わりました: だめ/);
});
