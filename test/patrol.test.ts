// 巡回の順番と間（Chrome を使わない。一覧と台帳は作り物）
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Patrol, type PatrolSpec, type RowState } from '../src/patrol.ts';

type Room = { latest?: number; have?: number; unread?: boolean; rendered?: boolean; fetches?: boolean };

let patrols: Patrol[] = [];
afterEach(() => { for (const p of patrols) p.stop(); patrols = []; });

/** 作り物の一覧。開くと（fetches なら）台帳が最新まで追いつく。時計は手で進める */
function world(rooms: Record<string, Room>, spec: Partial<PatrolSpec> = {}, important: string[] = []) {
  let t = 1_000_000;
  let selected: string | null = null;
  const opened: string[] = [];
  const logs: any[] = [];
  const p = new Patrol({ rows: '.row', key: '@data-id', settleMs: 1000, ...spec }, {
    behind: () => Object.entries(rooms).filter(([, r]) => r.latest !== undefined && (r.have ?? -1) < r.latest!).map(([stream, r]) => ({ stream, latest: r.latest!, have: r.have })),
    important: (s) => important.includes(s),
    rowState: async (s): Promise<RowState> => {
      const r = rooms[s];
      if (!r || r.rendered === false) return { present: false };
      return { present: true, selected: selected === s, unread: !!r.unread };
    },
    open: async (s, o) => {
      opened.push(o.reselect ? `${s}(開き直し)` : s);
      selected = s;
      const r = rooms[s];
      if (r && r.fetches !== false && r.latest !== undefined) { r.have = r.latest; r.unread = false; }
    },
    selectedStream: async () => selected,
    caughtUp: (s, latest) => (rooms[s]?.have ?? -1) >= latest,
    log: (x) => logs.push(x),
    now: () => t,
    sleep: async (ms) => { t += ms; },
  });
  patrols.push(p);
  return { p, opened, logs, advance: (ms: number) => { t += ms; }, select: (s: string) => { selected = s; } };
}

test('追いついていない部屋のうち、未読のものだけ開く（大事な部屋は未読でなくても開く）。最後に home へ戻す', async () => {
  const w = world({
    a: { latest: 5, have: 3, unread: true },
    b: { latest: 9, have: 2, unread: false }, // よそで読まれた
    me: { latest: 4, have: 1, unread: false }, // 大事な部屋
    c: { latest: 7, have: 7, unread: true },  // 追いついている
    home: {},
  }, { home: 'home' }, ['me']);
  await w.p.run();
  assert.deepEqual(w.opened, ['me', 'a', 'home']);
  const s = w.p.stats();
  assert.equal(s.opened, 2);
  assert.equal(s.caughtUp, 2);
});

test('すでに開いている部屋は、よそを開いてから戻すよう頼む', async () => {
  const w = world({ a: { latest: 5, have: 3, unread: true } });
  w.select('a');
  await w.p.run();
  assert.deepEqual(w.opened, ['a(開き直し)']);
});

test('開いても追いつかなければ失敗として間を空ける（大事な部屋は短い間で 3 回まで、そのあと長い間）', async () => {
  const w = world({ me: { latest: 5, have: 3, fetches: false } }, { retry: { importantMs: 20_000, importantTimes: 3, otherMs: 600_000 } }, ['me']);
  await w.p.run();
  assert.equal(w.opened.length, 1);
  await w.p.run(); // 間が明けていないので開かない
  assert.equal(w.opened.length, 1);
  // 最初の失敗と、そのあと 3 回は 20 秒ごとに開き直す
  for (let k = 2; k <= 4; k++) { w.advance(20_000); await w.p.run(); assert.equal(w.opened.length, k, `${k} 回目`); }
  // 4 回失敗したので、次は 10 分あと（20 秒では開かない）
  assert.equal(w.p.stats().waiting[0].failures, 4);
  w.advance(20_000); await w.p.run();
  assert.equal(w.opened.length, 4);
  w.advance(600_000); await w.p.run();
  assert.equal(w.opened.length, 5);
  assert.ok(w.logs.some((l) => l.type === 'patrol-failed'));
});

test('一覧に描かれていない部屋は黙らずに数え、間を空ける', async () => {
  const w = world({ a: { latest: 5, have: 3, unread: true, rendered: false } });
  await w.p.run();
  assert.deepEqual(w.opened, []);
  assert.equal(w.p.stats().notRendered, 1);
  assert.ok(w.logs.some((l) => l.type === 'patrol-not-rendered' && l.stream === 'a'));
});

test('続けて一覧に見つからない部屋は、間を倍々に広げ（6 時間まで）、状態に出す。見つかれば戻す', async () => {
  const room: Room = { latest: 5, have: 3, unread: true, rendered: false };
  const w = world({ a: room }, { retry: { otherMs: 600_000 } });
  const looks = async () => { await w.p.run(); return w.p.stats(); };
  await looks(); // 1 回目: 10 分
  w.advance(600_000); await looks(); // 2 回目: 20 分あと
  assert.deepEqual(w.p.stats().missingFromList, [{ stream: 'a', times: 2 }]);
  w.advance(600_000); await looks();
  assert.equal(w.p.stats().notRendered, 2, '20 分たつ前に、また探しに行った');
  w.advance(600_000); await looks(); // 3 回目: 40 分あと
  assert.equal(w.p.stats().notRendered, 3);
  const retryAt = Date.parse(w.p.stats().waiting[0].retryAt);
  assert.ok(retryAt - (1_000_000 + 1_800_000) >= 2_400_000 - 1, '3 回目のあとが 40 分になっていない');
  // 一覧に出てきたら、開いて、見つからない部屋の一覧から外れる
  room.rendered = true;
  w.advance(6 * 3600_000); await looks();
  assert.deepEqual(w.opened, ['a']);
  assert.deepEqual(w.p.stats().missingFromList, []);
});

test('巡回で開いた直後の持ち主の既読は無視する（間を過ぎれば受け取る）', async () => {
  const w = world({ a: { latest: 5, have: 3, unread: true } }, { ignoreOwnerReadMs: 90_000 });
  assert.equal(w.p.ignoreOwnerRead('a'), false, '開く前から無視している');
  await w.p.run();
  assert.equal(w.p.ignoreOwnerRead('a'), true);
  w.advance(90_000);
  assert.equal(w.p.ignoreOwnerRead('a'), false);
  assert.equal(w.p.stats().ignoredOwnerReads, 1);
});

test('突く: 未読でなくても開き直す。同じ部屋は 1 分に 1 回、巡回で開いた直後は跳ね返りとして断る', async () => {
  const w = world({ home: {} }, { nudge: { minIntervalMs: 60_000, echoMs: 15_000 } });
  assert.deepEqual(w.p.nudge('home'), { queued: true });
  await w.p.run();
  assert.deepEqual(w.opened, ['home']);
  assert.equal(w.p.nudge('home').queued, false); // 開いた直後（跳ね返り）
  w.advance(20_000);
  assert.match(w.p.nudge('home').reason ?? '', /間が短い/);
  w.advance(60_000);
  assert.equal(w.p.nudge('home').queued, true);
  await w.p.run();
  assert.deepEqual(w.opened, ['home', 'home(開き直し)']);
});

test('未読の印が無くて見送った部屋は、しばらく見直さない（毎回ページを見に行かない）', async () => {
  let looks = 0;
  const w = world({ b: { latest: 9, have: 2, unread: false } });
  const orig = (w.p as any);
  void orig;
  await w.p.run();
  w.p.stop();
  // 見送ったあとは候補から外れる
  const p2 = new Patrol({ rows: '.row', key: '@k' }, {
    behind: () => [{ stream: 'b', latest: 9, have: 2 }], important: () => false,
    rowState: async () => { looks++; return { present: true, unread: false }; },
    open: async () => {}, selectedStream: async () => null, caughtUp: () => false, log: () => {},
  });
  patrols.push(p2);
  await p2.run();
  await p2.run();
  assert.equal(looks, 1);
});
