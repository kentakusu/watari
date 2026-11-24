// 起こす条件。台帳に新しく入った発言を見て、条件に当たれば本文なしの 1 行で知らせる。
// 決まり（先に同種の道具を作った担当が、無いと誤報か取りこぼしになったもの）:
// - 有効にした時刻より前・古すぎる（maxAgeMinutes）・最初の一括取り込み（put の initial）では起こさない
// - 自分の発言では起こさない。例外は selfStreams（持ち主が Claude に話しかける部屋）
// - 持ち主が先に読んだ発言（stream ごとの ownerReadSeq 以下）では起こさない。例外は namedStreams と selfStreams
// - 同じ stream の続けての発言は、静けさ quietSeconds・最長 maxWaitSeconds で 1 つにまとめる
// - 1 時間に hourlyLimit を超えた分は「まとめ」1 件に畳む（selfStreams は上限の外）
// - 知らせる 1 行は本文を含めない: 「trigger id=… rules=… kind=… count=… stream=…」
import type { DatabaseSync } from 'node:sqlite';
import type { LedgerItem } from './ledger.ts';

export type TriggerRule = {
  name: string;
  toMe?: boolean;
  replyToMe?: boolean;
  toAll?: boolean;
  streamKinds?: string[];
  streams?: string[];
  /** 本文に含む語（どれか 1 つ） */
  keywords?: string[];
  /** 書き手の id か名前（どれか 1 つ・名前は部分一致） */
  authors?: string[];
  /** 書き手の種類（human / bot のどれか） */
  authorKinds?: string[];
  /** 持ち主がその部屋でこの時間内に発言していれば当たる（会話の続きを拾う） */
  spokeRecentlyHours?: number;
};

export type TriggerConfig = {
  /** 知らせる先（所属/名前） */
  notifyTo: string;
  /** この時刻より前の発言では起こさない（ISO）。書かなければ常駐が起きた時刻 */
  enabledAt?: string;
  maxAgeMinutes?: number;
  quietSeconds?: number;
  maxWaitSeconds?: number;
  hourlyLimit?: number;
  /** 持ち主が Claude に話しかける部屋（自分の発言でも起こす・上限の外） */
  selfStreams?: string[];
  /** 名指しの部屋（持ち主が先に読んでいても起こす） */
  namedStreams?: string[];
  /**
   * 起こしてよい書き手の種類（所属全体の既定・selfStreams と namedStreams にも効く）。例: ["human"]。
   * 書き手の種類が分からない発言（authorKind が無い）は通す。
   * 規則に authorKinds を書いたら、その規則で当たった発言には規則の指定を使う（ほかの人の Bot のメンションだけ起こす、など）。
   * ただし持ち主の側の発言（mine）には、いつもこの所属全体の指定を当てる
   */
  authorKinds?: string[];
  /** selfStreams の静けさ（既定 0 = 待たずにすぐ出す） */
  selfQuietSeconds?: number;
  /** 知らせの 1 行の頭に付ける固定の文（どこから来た知らせか・何をする行かを決めるため）。間は空白 1 つ */
  linePrefix?: string;
  /** 知らせの 1 行の尾に付ける固定の文。間は空白 1 つ */
  lineSuffix?: string;
  rules?: TriggerRule[];
};

export type Fire = { id: number; at: string; stream: string; streamName?: string; rules: string[]; kind: string; count: number; items: Array<{ stream: string; id: string }> };

type Pending = { stream: string; streamName?: string; kind: string; rules: Set<string>; items: LedgerItem[]; firstAt: number; quiet?: ReturnType<typeof setTimeout>; cap?: ReturnType<typeof setTimeout>; self: boolean };

const D = { maxAgeMinutes: 60, quietSeconds: 20, maxWaitSeconds: 120, hourlyLimit: 30 };

/** spokeRecently: 持ち主がその部屋で hours 時間内に発言したか（台帳の mine の発言で判定する） */
export function matchedRules(item: LedgerItem, cfg: TriggerConfig, spokeRecently: (stream: string, hours: number) => boolean = () => false): string[] {
  const out: string[] = [];
  // 所属全体の authorKinds に通るか（書き手の種類が分からない発言は通す）
  const globalOk = !cfg.authorKinds?.length || !item.authorKind || cfg.authorKinds.includes(item.authorKind);
  if (globalOk && cfg.selfStreams?.includes(item.stream)) out.push('self');
  if (globalOk && cfg.namedStreams?.includes(item.stream)) out.push('named');
  for (const r of cfg.rules ?? []) {
    const conds: boolean[] = [];
    if (r.toMe) conds.push(!!item.toMe);
    if (r.replyToMe) conds.push(!!item.replyToMe);
    if (r.toAll) conds.push(!!item.toAll);
    if (r.streamKinds?.length) conds.push(!!item.streamKind && r.streamKinds.includes(item.streamKind));
    if (r.streams?.length) conds.push(r.streams.includes(item.stream));
    if (r.keywords?.length) conds.push(r.keywords.some((k) => (item.text ?? '').includes(k)));
    if (r.authors?.length) conds.push(r.authors.some((a) => item.author === a || (!!item.authorName && item.authorName.includes(a))));
    if (r.authorKinds?.length) conds.push(!!item.authorKind && r.authorKinds.includes(item.authorKind));
    if (r.spokeRecentlyHours) conds.push(spokeRecently(item.stream, r.spokeRecentlyHours));
    // 規則に authorKinds を書いたら、その規則では所属全体の authorKinds より規則の指定を使う。
    // ただし持ち主の側の発言（mine）には、いつも所属全体の指定を当てる（自分の Bot の返事で自分を起こさないため）
    const authorOk = globalOk || (!!r.authorKinds?.length && !item.mine);
    if (conds.length && conds.every(Boolean) && authorOk) out.push(r.name);
  }
  return out;
}

/** 起こさない理由（起こすなら null） */
export function skipReason(item: LedgerItem, cfg: TriggerConfig, enabledAt: string, ownerReadSeq: number | undefined, now = Date.now()): string | null {
  const self = !!cfg.selfStreams?.includes(item.stream);
  const named = !!cfg.namedStreams?.includes(item.stream);
  if (item.at < enabledAt) return '有効にする前の発言';
  if (now - Date.parse(item.at) > (cfg.maxAgeMinutes ?? D.maxAgeMinutes) * 60000) return '古すぎる';
  if (item.recalled) return '取り消し';
  if (item.mine && !self) return '自分の発言';
  if (!self && !named && item.seq !== undefined && ownerReadSeq !== undefined && item.seq <= ownerReadSeq) return '持ち主が先に読んだ';
  return null;
}

export class TriggerEngine {
  #db: DatabaseSync;
  #config: () => TriggerConfig | undefined;
  #send: (to: string, line: string) => Promise<void>;
  #log: (rec: object) => void;
  #ownerRead: (stream: string) => number | undefined;
  /**
   * 設定に enabledAt が無いときの「有効にした時刻」。この所属で起こす条件を初めて使った時刻を台帳に残し、起こし直しても引き継ぐ。
   * （以前は作った瞬間の時刻にしていたので、常駐を起こし直すたびに、そのあと最初に入った発言で起こしていなかった）
   */
  #enabledAt = '';
  #pending = new Map<string, Pending>();
  #overflow: Pending[] = [];
  #recent: number[] = [];
  #sweeper: ReturnType<typeof setInterval>;

  constructor(opts: { db: DatabaseSync; config: () => TriggerConfig | undefined; send: (to: string, line: string) => Promise<void>; log: (rec: object) => void; ownerRead: (stream: string) => number | undefined }) {
    this.#db = opts.db;
    this.#config = opts.config;
    this.#send = opts.send;
    this.#log = opts.log;
    this.#ownerRead = opts.ownerRead;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS fires (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, stream TEXT NOT NULL, stream_name TEXT,
      rules TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, items_json TEXT NOT NULL, to_session TEXT, status TEXT NOT NULL, error TEXT)`);
    this.#db.exec('CREATE TABLE IF NOT EXISTS trigger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.#db.prepare(`INSERT OR IGNORE INTO trigger_meta (key, value) VALUES ('enabled_at', ?)`).run(new Date().toISOString());
    this.#enabledAt = (this.#db.prepare(`SELECT value FROM trigger_meta WHERE key = 'enabled_at'`).get() as any).value;
    this.#sweeper = setInterval(() => void this.flushOverflow(), 60000);
    this.#sweeper.unref?.();
  }

  stop(): void {
    clearInterval(this.#sweeper);
    for (const p of this.#pending.values()) { clearTimeout(p.quiet); clearTimeout(p.cap); }
    this.#pending.clear();
  }

  /** 台帳に新しく入った発言を見る。initial（最初の一括取り込み）なら何もしない */
  consider(items: LedgerItem[], opt: { initial?: boolean } = {}): void {
    const cfg = this.#config();
    if (!cfg || opt.initial) return;
    const enabledAt = cfg.enabledAt ?? this.#enabledAt;
    for (const item of items) {
      const why = skipReason(item, cfg, enabledAt, this.#ownerRead(item.stream));
      if (why) continue;
      const rules = matchedRules(item, cfg, (stream, hours) => this.#spokeRecently(stream, hours));
      if (!rules.length) continue;
      this.#add(item, rules, cfg);
    }
  }

  #add(item: LedgerItem, rules: string[], cfg: TriggerConfig): void {
    let p = this.#pending.get(item.stream);
    if (!p) {
      p = { stream: item.stream, streamName: item.streamName, kind: item.streamKind ?? 'other', rules: new Set(), items: [], firstAt: Date.now(), self: !!cfg.selfStreams?.includes(item.stream) };
      this.#pending.set(item.stream, p);
      const pp = p;
      p.cap = setTimeout(() => void this.#fire(pp), (cfg.maxWaitSeconds ?? D.maxWaitSeconds) * 1000);
    }
    for (const r of rules) p.rules.add(r);
    p.items.push(item);
    clearTimeout(p.quiet);
    const pp = p;
    // 自分の 1:1 は待たずに出す（同じ取り込みの中で続けて入った分だけはまとまる）
    const quiet = p.self ? (cfg.selfQuietSeconds ?? 0) : (cfg.quietSeconds ?? D.quietSeconds);
    p.quiet = setTimeout(() => void this.#fire(pp), quiet * 1000);
  }

  /** 持ち主がその部屋で hours 時間内に発言したか（台帳の mine の発言の時刻で見る） */
  #spokeRecently(stream: string, hours: number): boolean {
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    return !!this.#db.prepare('SELECT 1 FROM items WHERE stream = ? AND mine = 1 AND at >= ? LIMIT 1').get(stream, since);
  }

  /** 待たずに今まとまっている分を出す（試験と、止めるとき用） */
  async flush(): Promise<void> {
    for (const p of [...this.#pending.values()]) await this.#fire(p);
  }

  async #fire(p: Pending): Promise<void> {
    if (this.#pending.get(p.stream) !== p) return; // もう出した
    this.#pending.delete(p.stream);
    clearTimeout(p.quiet); clearTimeout(p.cap);
    const cfg = this.#config();
    if (!cfg) return;
    const now = Date.now();
    this.#recent = this.#recent.filter((t) => now - t < 3600_000);
    if (!p.self && this.#recent.length >= (cfg.hourlyLimit ?? D.hourlyLimit)) {
      this.#overflow.push(p);
      this.#log({ type: 'trigger-overflow', stream: p.stream, count: p.items.length });
      return;
    }
    if (!p.self) this.#recent.push(now);
    await this.#deliver(cfg, p.stream, p.streamName, [...p.rules], p.kind, p.items.map((i) => ({ stream: i.stream, id: i.id })));
  }

  /** 上限で溜めた分を「まとめ」1 件で出す（1 分ごとに呼ばれる。試験からも呼べる） */
  async flushOverflow(): Promise<void> {
    const cfg = this.#config();
    if (!cfg || !this.#overflow.length) return;
    const now = Date.now();
    this.#recent = this.#recent.filter((t) => now - t < 3600_000);
    if (this.#recent.length >= (cfg.hourlyLimit ?? D.hourlyLimit)) return;
    const all = this.#overflow.splice(0);
    this.#recent.push(now);
    const items = all.flatMap((p) => p.items.map((i) => ({ stream: i.stream, id: i.id })));
    const rules = [...new Set(all.flatMap((p) => [...p.rules]))];
    await this.#deliver(cfg, '(まとめ)', `${new Set(all.map((p) => p.stream)).size} 部屋`, rules, 'summary', items);
  }

  async #deliver(cfg: TriggerConfig, stream: string, streamName: string | undefined, rules: string[], kind: string, items: Array<{ stream: string; id: string }>): Promise<void> {
    const at = new Date().toISOString();
    const r = this.#db.prepare(`INSERT INTO fires (at, stream, stream_name, rules, kind, count, items_json, to_session, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sending')`)
      .run(at, stream, streamName ?? null, rules.join(','), kind, items.length, JSON.stringify(items), cfg.notifyTo);
    const id = Number(r.lastInsertRowid);
    // 本文は入れない（読むときは ledger_read で引く）
    const core = `trigger id=${id} rules=${rules.join(',')} kind=${kind} count=${items.length} stream=${streamName ?? stream}`;
    // 頭と尾は設定の固定の文だけ（発言の本文は入れない）。改行は 1 行を保つために空白にする
    const oneLine = (s?: string) => (s ?? '').replace(/[\r\n]+/g, ' ').trim();
    const line = [oneLine(cfg.linePrefix), core, oneLine(cfg.lineSuffix)].filter(Boolean).join(' ');
    try {
      await this.#send(cfg.notifyTo, line);
      this.#db.prepare(`UPDATE fires SET status = 'delivered' WHERE id = ?`).run(id);
      this.#log({ type: 'trigger', id, stream, rules, kind, count: items.length, to: cfg.notifyTo });
    } catch (e: any) {
      this.#db.prepare(`UPDATE fires SET status = 'failed', error = ? WHERE id = ?`).run(String(e?.message ?? e), id);
      this.#log({ type: 'trigger-failed', id, stream, error: String(e?.message ?? e) });
    }
  }

  /** 届けの状態（「0 件」を「届いていない」と区別するため） */
  stats(): { pending: number; overflow: number; delivered: number; failed: number; aiUnreadFires: number; oldestAiUnreadFireAt?: string } {
    const q = (s: string) => (this.#db.prepare(`SELECT COUNT(*) n FROM fires WHERE status = ?`).get(s) as any).n as number;
    // AI がまだ読んでいない発言を含む発火
    const unread = this.#db.prepare(`SELECT f.id, f.at, f.items_json FROM fires f WHERE f.status = 'delivered' ORDER BY f.id DESC LIMIT 500`).all() as any[];
    const isRead = this.#db.prepare('SELECT ai_read_at FROM items WHERE stream = ? AND id = ?');
    let aiUnreadFires = 0;
    let oldest: string | undefined;
    for (const f of unread) {
      const items = JSON.parse(f.items_json) as Array<{ stream: string; id: string }>;
      if (items.some((i) => !(isRead.get(i.stream, i.id) as any)?.ai_read_at)) { aiUnreadFires++; oldest = f.at; }
    }
    return { pending: this.#pending.size, overflow: this.#overflow.reduce((n, p) => n + p.items.length, 0), delivered: q('delivered'), failed: q('failed'), aiUnreadFires, oldestAiUnreadFireAt: oldest };
  }

  recentFires(limit = 20): Fire[] {
    return (this.#db.prepare('SELECT * FROM fires ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 200)) as any[]).map((f) => ({
      id: f.id, at: f.at, stream: f.stream, streamName: f.stream_name ?? undefined, rules: f.rules ? f.rules.split(',') : [], kind: f.kind, count: f.count, items: JSON.parse(f.items_json),
    }));
  }
}
