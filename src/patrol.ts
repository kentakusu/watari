// 巡回: 拡張が「一覧の形」を宣言し、「部屋ごとの最新の番号」を報告するだけで、
// どの部屋を・いつ・どれくらいの間で開くかを本体が受け持つ。
// - 開く候補: サイトが言う最新の番号まで台帳が追いついていない部屋のうち、一覧で未読の印があるもの、
//   または大事な部屋（起こす条件の selfStreams・namedStreams）。突かれた部屋（nudge）は、未読でなくても開く
// - 開き方: すでに開いている部屋は、よそを開いてから戻す（開き直さないと取り直さないサイトのため）
// - 開いたら、台帳が最新の番号に追いつくまで待つ。追いつかなければ失敗として間を空ける
//   （大事な部屋は短い間で数回まで、ほかは長い間）
// - 巡回の最後に、決めた部屋（home）へ戻す
// - 巡回で開いた直後は、サイトが勝手に付ける既読を「持ち主が読んだ」とは扱わない
// ページを触る処理は窓の側（PatrolDeps）が持つ。ここは順番と間だけを決める（Chrome なしで試せる）。

export type PatrolSpec = {
  /** 一覧の行（document から querySelectorAll で探す） */
  rows: string;
  /** 行の中の、部屋の鍵（'@属性' / 'セレクタ@属性' / 'セレクタ'（テキスト）。collect の fields と同じ書き方） */
  key: string;
  /** 行が今開いている印（行そのものに当たるか、行の中にあるかを見る） */
  selected?: string;
  /** 行が未読の印（同上） */
  unread?: string;
  /** 巡回の最後に開いておく部屋の鍵 */
  home?: string;
  /** 開いたあと、台帳が最新の番号に追いつくまで待つ時間（既定 8000ms） */
  settleMs?: number;
  /** 失敗したときの間（既定: 大事な部屋は 20 秒で 3 回まで、そのあと・ほかの部屋は 10 分） */
  retry?: { importantMs?: number; importantTimes?: number; otherMs?: number };
  /** 巡回で開いた直後、持ち主の既読の報告を無視する間（既定 90 秒） */
  ignoreOwnerReadMs?: number;
  /** 突く口（nudge）の間: 同じ部屋は minIntervalMs に 1 回（既定 60 秒）。巡回で開いた直後 echoMs は跳ね返りとして無視（既定 15 秒） */
  nudge?: { minIntervalMs?: number; echoMs?: number };
};

export type RowState = { present: boolean; selected?: boolean; unread?: boolean };

export type PatrolDeps = {
  /** 最新の番号まで台帳が追いついていない部屋 */
  behind(): Array<{ stream: string; latest: number; have?: number }>;
  /** 大事な部屋か（未読の印が無くても開く・短い間で開き直す） */
  important(stream: string): boolean;
  /** 一覧の行の様子（描かれていなければ、一覧をたどって探す） */
  rowState(stream: string): Promise<RowState>;
  /** 行を押して部屋を開く。reselect: すでに開いているので、よそを開いてから戻す */
  open(stream: string, opt: { reselect: boolean }): Promise<void>;
  /** 今開いている部屋の鍵（分からなければ null） */
  selectedStream(): Promise<string | null>;
  /** 台帳が latest まで追いついたか */
  caughtUp(stream: string, latest: number): boolean;
  log(rec: object): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
};

export type PatrolStats = {
  runs: number; opened: number; caughtUp: number; failed: number; notRendered: number; ignoredOwnerReads: number;
  lastRunAt?: string; lastError?: string;
  waiting: Array<{ stream: string; failures: number; retryAt: string }>;
};

export class Patrol {
  readonly spec: PatrolSpec;
  #d: PatrolDeps;
  #now: () => number;
  #sleep: (ms: number) => Promise<void>;
  #running = false;
  #again = false;
  #stopped = false;
  #scheduled?: ReturnType<typeof setTimeout>;
  #ticker: ReturnType<typeof setInterval>;
  #forced = new Set<string>();
  #fails = new Map<string, { count: number; until: number }>();
  #skipUntil = new Map<string, number>();
  #openedAt = new Map<string, number>();
  #lastNudge = new Map<string, number>();
  #stats: PatrolStats = { runs: 0, opened: 0, caughtUp: 0, failed: 0, notRendered: 0, ignoredOwnerReads: 0, waiting: [] };

  constructor(spec: PatrolSpec, deps: PatrolDeps) {
    this.spec = spec;
    this.#d = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    // 失敗の間が明けた部屋を拾うため、ときどき見直す（台帳を引くだけ。ページは触らない）
    this.#ticker = setInterval(() => { if (this.#due().length) this.schedule(); }, 5000);
    this.#ticker.unref?.();
  }

  get #settleMs() { return this.spec.settleMs ?? 8000; }

  /** 巡回を（少し待ってから）回す。回っている最中なら、終わったあともう一度回す */
  schedule(delayMs = 300): void {
    if (this.#stopped) return;
    if (this.#running) { this.#again = true; return; }
    if (this.#scheduled) return;
    this.#scheduled = setTimeout(() => { this.#scheduled = undefined; void this.run(); }, delayMs);
  }

  /** 開く候補（間を空けている部屋・しばらく見送る部屋を除く）。大事な部屋・突かれた部屋を先に */
  #due(): Array<{ stream: string; latest?: number; important: boolean; forced: boolean }> {
    const t = this.#now();
    const out = new Map<string, { stream: string; latest?: number; important: boolean; forced: boolean }>();
    for (const b of this.#d.behind()) out.set(b.stream, { stream: b.stream, latest: b.latest, important: this.#d.important(b.stream), forced: false });
    for (const s of this.#forced) {
      const x = out.get(s);
      if (x) x.forced = true;
      else out.set(s, { stream: s, important: this.#d.important(s), forced: true });
    }
    return [...out.values()]
      .filter((c) => (this.#fails.get(c.stream)?.until ?? 0) <= t && (c.forced || (this.#skipUntil.get(c.stream) ?? 0) <= t))
      .sort((a, b) => Number(b.forced || b.important) - Number(a.forced || a.important));
  }

  async run(): Promise<void> {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    try {
      do {
        this.#again = false;
        await this.#pass();
      } while (this.#again && !this.#stopped);
    } catch (e: any) {
      this.#stats.lastError = String(e?.message ?? e);
      this.#d.log({ type: 'patrol-error', error: this.#stats.lastError });
    } finally {
      this.#running = false;
    }
  }

  async #pass(): Promise<void> {
    const due = this.#due();
    if (!due.length) return;
    this.#stats.runs++;
    this.#stats.lastRunAt = new Date(this.#now()).toISOString();
    let openedAny = false;
    for (const c of due) {
      if (this.#stopped) return;
      const row = await this.#d.rowState(c.stream);
      if (!row.present) {
        // 一覧に見つからない（描かれていない・一覧から外れた）。黙らずに数え、間を空ける
        this.#stats.notRendered++;
        this.#d.log({ type: 'patrol-not-rendered', stream: c.stream });
        this.#fail(c.stream, c.important);
        this.#forced.delete(c.stream);
        continue;
      }
      if (!c.forced && !c.important && !row.unread) {
        // 未読の印が無い（持ち主がよそで読んだなど）。開かずに、しばらく見送る
        this.#skipUntil.set(c.stream, this.#now() + 30_000);
        continue;
      }
      this.#forced.delete(c.stream);
      const started = this.#now();
      this.#openedAt.set(c.stream, started);
      await this.#d.open(c.stream, { reselect: !!row.selected });
      openedAny = true;
      this.#stats.opened++;
      if (c.latest === undefined) {
        // 突かれただけで、待つ番号が無い。少し待って終わり（画面に取り直させるのが目的）
        await this.#sleep(Math.min(this.#settleMs, 1500));
        this.#d.log({ type: 'patrol-opened', stream: c.stream, reason: 'nudge', ms: this.#now() - started });
        continue;
      }
      const ok = await this.#waitCaughtUp(c.stream, c.latest);
      if (ok) {
        this.#stats.caughtUp++;
        this.#fails.delete(c.stream);
        this.#d.log({ type: 'patrol-opened', stream: c.stream, latest: c.latest, caughtUp: true, ms: this.#now() - started });
      } else {
        this.#fail(c.stream, c.important);
        this.#d.log({ type: 'patrol-failed', stream: c.stream, latest: c.latest, failures: this.#fails.get(c.stream)?.count, ms: this.#now() - started });
      }
    }
    const home = this.spec.home;
    if (openedAny && home && !this.#stopped) {
      const cur = await this.#d.selectedStream();
      if (cur !== home) {
        const row = await this.#d.rowState(home);
        if (row.present) {
          this.#openedAt.set(home, this.#now());
          await this.#d.open(home, { reselect: false });
          this.#d.log({ type: 'patrol-home', stream: home });
        } else {
          this.#stats.notRendered++;
          this.#d.log({ type: 'patrol-not-rendered', stream: home, home: true });
        }
      }
    }
    this.#refreshWaiting();
  }

  async #waitCaughtUp(stream: string, latest: number): Promise<boolean> {
    const end = this.#now() + this.#settleMs;
    for (;;) {
      if (this.#d.caughtUp(stream, latest)) return true;
      if (this.#now() >= end || this.#stopped) return false;
      await this.#sleep(250);
    }
  }

  #fail(stream: string, important: boolean): void {
    const r = this.spec.retry ?? {};
    const count = (this.#fails.get(stream)?.count ?? 0) + 1;
    const short = important && count <= (r.importantTimes ?? 3);
    this.#fails.set(stream, { count, until: this.#now() + (short ? r.importantMs ?? 20_000 : r.otherMs ?? 600_000) });
    this.#stats.failed++;
  }

  #refreshWaiting(): void {
    const t = this.#now();
    this.#stats.waiting = [...this.#fails.entries()].filter(([, f]) => f.until > t)
      .map(([stream, f]) => ({ stream, failures: f.count, retryAt: new Date(f.until).toISOString() }));
  }

  /** 巡回で開いた直後か（そのあいだの「持ち主の既読」は、サイトが勝手に付けたものとみなす） */
  ignoreOwnerRead(stream: string): boolean {
    const at = this.#openedAt.get(stream);
    const hit = at !== undefined && this.#now() - at < (this.spec.ignoreOwnerReadMs ?? 90_000);
    if (hit) this.#stats.ignoredOwnerReads++;
    return hit;
  }

  /** 突く: その部屋を、未読の印が無くても開き直させる（取り直させる）。間が短いもの・跳ね返りは断る */
  nudge(stream: string): { queued: boolean; reason?: string } {
    const t = this.#now();
    const n = this.spec.nudge ?? {};
    const opened = this.#openedAt.get(stream);
    if (opened !== undefined && t - opened < (n.echoMs ?? 15_000)) return { queued: false, reason: '巡回で開いた直後（跳ね返り）' };
    const last = this.#lastNudge.get(stream);
    if (last !== undefined && t - last < (n.minIntervalMs ?? 60_000)) return { queued: false, reason: '前に突いてから間が短い' };
    this.#lastNudge.set(stream, t);
    this.#forced.add(stream);
    this.schedule();
    return { queued: true };
  }

  stats(): PatrolStats {
    this.#refreshWaiting();
    return structuredClone(this.#stats);
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#ticker);
    if (this.#scheduled) clearTimeout(this.#scheduled);
  }
}
