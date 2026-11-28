// 発言の台帳。拡張が読み解いた発言（チャット・メール・通知など）を、所属ごとに 1 つの SQLite に残す。
// - 同じ発言（stream と id の組）は 1 回だけ。中身が変わったら（取り消し・編集）更新として返す
// - stream ごとに番号（seq）の歯抜けを数える
// - 消したあとに同じ発言を取り直しても「新しい」と扱わない（見たことのある組を別に残す）
// - 全文検索は FTS5 の trigram（日本語の部分一致。3 文字未満は LIKE で探す）
// 置き場: <WATARI_HOME>/ledger/<所属>.db（置き場の権限は常駐が絞る）
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type StreamKind = 'direct' | 'group' | 'self' | 'bot' | 'other';
export type AuthorKind = 'human' | 'bot';

/** 拡張が台帳に渡す 1 件 */
export type LedgerItemInput = {
  /** 部屋・スレッド・宛先の組など、発言のまとまり */
  stream: string;
  /** stream の中で一意な id */
  id: string;
  /** stream の中の通し番号（あれば歯抜けを数える） */
  seq?: number;
  streamKind?: StreamKind;
  streamName?: string;
  /** 書き手の id */
  author?: string;
  authorKind?: AuthorKind;
  authorName?: string;
  /** 書かれた時刻（ISO 文字列か、ミリ秒） */
  at: string | number;
  text?: string;
  /** 宛先の id */
  to?: string[];
  /** 全員宛て */
  toAll?: boolean;
  /** 持ち主（この窓のログインの人）宛てか。拡張が判断して入れる */
  toMe?: boolean;
  /** 返信先 */
  replyTo?: { id: string; author?: string; authorName?: string };
  /** 持ち主への返信か。拡張が判断して入れる */
  replyToMe?: boolean;
  /** 持ち主（とその側の Bot）が書いたものか */
  mine?: boolean;
  /** 取り消された */
  recalled?: boolean;
  /** そのほか、拡張が残したいもの（JSON にできるもの） */
  meta?: unknown;
};

export type LedgerItem = Required<Pick<LedgerItemInput, 'stream' | 'id'>> & Omit<LedgerItemInput, 'at'> & {
  at: string;
  firstSeenAt: string;
  updatedAt: string;
  /** AI が ledger_read で読んだ時刻 */
  aiReadAt?: string;
};

export type PutResult = { added: LedgerItem[]; updated: LedgerItem[]; unchanged: number; seenBefore: number };

const iso = (t: string | number) => new Date(t).toISOString();

const COLUMNS = `stream TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER, stream_kind TEXT, stream_name TEXT,
  author TEXT, author_kind TEXT, author_name TEXT, at TEXT NOT NULL, text TEXT, to_json TEXT, to_all INTEGER,
  to_me INTEGER, reply_to_json TEXT, reply_to_me INTEGER, mine INTEGER, recalled INTEGER, meta_json TEXT,
  hash TEXT NOT NULL, first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL, ai_read_at TEXT,
  PRIMARY KEY (stream, id)`;

function hashOf(i: LedgerItemInput): string {
  const body = JSON.stringify([i.seq ?? null, i.streamKind ?? null, i.streamName ?? null, i.author ?? null, i.authorKind ?? null, i.authorName ?? null,
    iso(i.at), i.text ?? null, i.to ?? null, !!i.toAll, !!i.toMe, i.replyTo ?? null, !!i.replyToMe, !!i.mine, !!i.recalled, i.meta ?? null]);
  return createHash('sha256').update(body).digest('hex');
}

function rowToItem(r: any): LedgerItem {
  const item: LedgerItem = {
    stream: r.stream, id: r.id, at: r.at, firstSeenAt: r.first_seen_at, updatedAt: r.updated_at,
  };
  if (r.seq !== null) item.seq = r.seq;
  if (r.stream_kind) item.streamKind = r.stream_kind;
  if (r.stream_name) item.streamName = r.stream_name;
  if (r.author) item.author = r.author;
  if (r.author_kind) item.authorKind = r.author_kind;
  if (r.author_name) item.authorName = r.author_name;
  if (r.text !== null) item.text = r.text;
  if (r.to_json) item.to = JSON.parse(r.to_json);
  if (r.to_all) item.toAll = true;
  if (r.to_me) item.toMe = true;
  if (r.reply_to_json) item.replyTo = JSON.parse(r.reply_to_json);
  if (r.reply_to_me) item.replyToMe = true;
  if (r.mine) item.mine = true;
  if (r.recalled) item.recalled = true;
  if (r.meta_json) item.meta = JSON.parse(r.meta_json);
  if (r.ai_read_at) item.aiReadAt = r.ai_read_at;
  return item;
}

export function validateItem(i: any): string | null {
  if (!i || typeof i !== 'object') return '発言がオブジェクトではありません';
  if (typeof i.stream !== 'string' || !i.stream) return 'stream が要ります';
  if (typeof i.id !== 'string' || !i.id) return 'id が要ります';
  if (i.at === undefined || Number.isNaN(new Date(i.at).getTime())) return `at が時刻として読めません: ${i.at}`;
  if (i.seq !== undefined && !Number.isInteger(i.seq)) return 'seq は整数';
  return null;
}

export class Ledger {
  readonly db: DatabaseSync;

  constructor(home: string, affiliation: string) {
    const dir = join(home, 'ledger');
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, `${affiliation}.db`));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS items (${COLUMNS});
      CREATE INDEX IF NOT EXISTS items_at ON items(at);
      CREATE INDEX IF NOT EXISTS items_stream_at ON items(stream, at);
      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(text, stream_name, author_name, tokenize = 'trigram');
      CREATE TABLE IF NOT EXISTS fts_map (stream TEXT NOT NULL, id TEXT NOT NULL, fts_rowid INTEGER NOT NULL, PRIMARY KEY (stream, id));
      CREATE TABLE IF NOT EXISTS seen (stream TEXT NOT NULL, id TEXT NOT NULL, first_seen_at TEXT NOT NULL, PRIMARY KEY (stream, id));
      CREATE TABLE IF NOT EXISTS streams (stream TEXT PRIMARY KEY, kind TEXT, name TEXT, owner_read_seq INTEGER, owner_read_at TEXT);
    `);
    // 前の版の台帳には無い欄を足す（巡回: サイトが言う「その部屋の最新の番号」）
    const cols = (this.db.prepare('PRAGMA table_info(streams)').all() as any[]).map((r) => r.name);
    if (!cols.includes('latest_seq')) this.db.exec('ALTER TABLE streams ADD COLUMN latest_seq INTEGER; ALTER TABLE streams ADD COLUMN latest_at TEXT;');
  }

  /** サイトが言う「その部屋の最新の番号」を残す（巡回で、台帳がそこまで追いついているかを見るため。小さくはしない） */
  setLatest(stream: string, seq: number): void {
    this.db.prepare(`INSERT INTO streams (stream, latest_seq, latest_at) VALUES (?, ?, ?)
      ON CONFLICT(stream) DO UPDATE SET latest_seq = MAX(COALESCE(streams.latest_seq, -1), excluded.latest_seq), latest_at = excluded.latest_at`)
      .run(stream, seq, new Date().toISOString());
  }

  latestSeq(stream: string): number | undefined {
    const r = this.db.prepare('SELECT latest_seq FROM streams WHERE stream = ?').get(stream) as any;
    return r?.latest_seq ?? undefined;
  }

  /** 台帳に入っている、その部屋のいちばん大きい番号 */
  maxSeq(stream: string): number | undefined {
    const r = this.db.prepare('SELECT MAX(seq) AS m FROM items WHERE stream = ?').get(stream) as any;
    return r?.m ?? undefined;
  }

  /** 最新の番号まで台帳が追いついていない部屋（巡回で開く候補） */
  behind(): Array<{ stream: string; latest: number; have?: number }> {
    const rows = this.db.prepare(`SELECT s.stream, s.latest_seq AS latest, (SELECT MAX(seq) FROM items i WHERE i.stream = s.stream) AS have
      FROM streams s WHERE s.latest_seq IS NOT NULL`).all() as any[];
    return rows.filter((r) => r.have === null || r.have < r.latest).map((r) => ({ stream: r.stream, latest: r.latest, have: r.have ?? undefined }));
  }

  close(): void { this.db.close(); }

  /** 発言を入れる。新しいもの・中身が変わったものだけを返す */
  put(inputs: LedgerItemInput[]): PutResult {
    const now = new Date().toISOString();
    const res: PutResult = { added: [], updated: [], unchanged: 0, seenBefore: 0 };
    const getRow = this.db.prepare('SELECT * FROM items WHERE stream = ? AND id = ?');
    const wasSeen = this.db.prepare('SELECT 1 FROM seen WHERE stream = ? AND id = ?');
    const insert = this.db.prepare(`INSERT INTO items (stream, id, seq, stream_kind, stream_name, author, author_kind, author_name, at, text, to_json, to_all, to_me,
      reply_to_json, reply_to_me, mine, recalled, meta_json, hash, first_seen_at, updated_at, ai_read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(stream, id) DO UPDATE SET seq = excluded.seq, stream_kind = excluded.stream_kind, stream_name = excluded.stream_name,
        author = excluded.author, author_kind = excluded.author_kind, author_name = excluded.author_name, at = excluded.at, text = excluded.text,
        to_json = excluded.to_json, to_all = excluded.to_all, to_me = excluded.to_me, reply_to_json = excluded.reply_to_json,
        reply_to_me = excluded.reply_to_me, mine = excluded.mine, recalled = excluded.recalled, meta_json = excluded.meta_json,
        hash = excluded.hash, updated_at = excluded.updated_at`);
    const markSeen = this.db.prepare('INSERT OR IGNORE INTO seen (stream, id, first_seen_at) VALUES (?, ?, ?)');
    const upStream = this.db.prepare(`INSERT INTO streams (stream, kind, name) VALUES (?, ?, ?)
      ON CONFLICT(stream) DO UPDATE SET kind = COALESCE(excluded.kind, streams.kind), name = COALESCE(excluded.name, streams.name)`);
    const ftsFind = this.db.prepare('SELECT fts_rowid FROM fts_map WHERE stream = ? AND id = ?');
    const ftsDel = this.db.prepare('DELETE FROM items_fts WHERE rowid = ?');
    const ftsIns = this.db.prepare('INSERT INTO items_fts (text, stream_name, author_name) VALUES (?, ?, ?)');
    const ftsMap = this.db.prepare('INSERT OR REPLACE INTO fts_map (stream, id, fts_rowid) VALUES (?, ?, ?)');

    this.db.exec('BEGIN');
    try {
      for (const i of inputs) {
        const bad = validateItem(i);
        if (bad) throw new Error(`台帳に入れられません（${bad}）: ${JSON.stringify(i).slice(0, 200)}`);
        const hash = hashOf(i);
        const old = getRow.get(i.stream, i.id) as any;
        if (old && old.hash === hash) { res.unchanged++; continue; }
        const seenBefore = !old && !!wasSeen.get(i.stream, i.id);
        insert.run(i.stream, i.id, i.seq ?? null, i.streamKind ?? null, i.streamName ?? null, i.author ?? null, i.authorKind ?? null, i.authorName ?? null,
          iso(i.at), i.text ?? null, i.to ? JSON.stringify(i.to) : null, i.toAll ? 1 : 0, i.toMe ? 1 : 0,
          i.replyTo ? JSON.stringify(i.replyTo) : null, i.replyToMe ? 1 : 0, i.mine ? 1 : 0, i.recalled ? 1 : 0,
          i.meta === undefined ? null : JSON.stringify(i.meta), hash, old?.first_seen_at ?? now, now);
        markSeen.run(i.stream, i.id, now);
        if (i.streamKind || i.streamName) upStream.run(i.stream, i.streamKind ?? null, i.streamName ?? null);
        const prev = ftsFind.get(i.stream, i.id) as any;
        if (prev) ftsDel.run(prev.fts_rowid);
        const r = ftsIns.run(i.text ?? '', i.streamName ?? '', i.authorName ?? '');
        ftsMap.run(i.stream, i.id, Number(r.lastInsertRowid));
        const item = rowToItem(getRow.get(i.stream, i.id));
        if (old) res.updated.push(item);
        else if (seenBefore) res.seenBefore++; // 消したあとに取り直したもの: 新しいとは扱わない
        else res.added.push(item);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return res;
  }

  /**
   * 外から入れる口（ledger.put）の入れ手（source）ごとの記録。0 件でも呼べば「見に行った時刻」を残す
   * （「新着なし」と「入れ手が止まっている」を分けるため）。
   */
  recordSource(name: string, r: { added?: number; updated?: number; error?: string }): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS sources (name TEXT PRIMARY KEY, last_call_at TEXT, last_added_at TEXT, calls INTEGER NOT NULL DEFAULT 0,
      added INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_error_at TEXT)`);
    const now = new Date().toISOString();
    this.db.prepare('INSERT OR IGNORE INTO sources (name) VALUES (?)').run(name);
    if (r.error !== undefined) {
      this.db.prepare('UPDATE sources SET errors = errors + 1, last_error = ?, last_error_at = ? WHERE name = ?').run(r.error.slice(0, 500), now, name);
      return;
    }
    this.db.prepare(`UPDATE sources SET last_call_at = ?, calls = calls + 1, added = added + ?, updated = updated + ?,
      last_added_at = CASE WHEN ? > 0 THEN ? ELSE last_added_at END WHERE name = ?`).run(now, r.added ?? 0, r.updated ?? 0, r.added ?? 0, now, name);
  }

  sources(): Array<{ name: string; lastCallAt?: string; lastAddedAt?: string; calls: number; added: number; updated: number; errors: number; lastError?: string; lastErrorAt?: string }> {
    const has = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sources'`).get();
    if (!has) return [];
    return (this.db.prepare('SELECT * FROM sources ORDER BY name').all() as any[]).map((r) => ({
      name: r.name, lastCallAt: r.last_call_at ?? undefined, lastAddedAt: r.last_added_at ?? undefined, calls: r.calls, added: r.added, updated: r.updated,
      errors: r.errors, lastError: r.last_error ?? undefined, lastErrorAt: r.last_error_at ?? undefined,
    }));
  }

  /** まだ 1 件も見たことがない（この所属の最初の取り込みかどうかに使う。消したあとも見たことは残る） */
  neverSeen(): boolean {
    return !this.db.prepare('SELECT 1 FROM seen LIMIT 1').get();
  }

  get(stream: string, id: string): LedgerItem | undefined {
    const r = this.db.prepare('SELECT * FROM items WHERE stream = ? AND id = ?').get(stream, id);
    return r ? rowToItem(r) : undefined;
  }

  /** 持ち主がその stream でどこまで読んだか（別の端末で読んだ分を起こさないため） */
  setOwnerRead(stream: string, seq: number, at?: string | number): void {
    this.db.prepare(`INSERT INTO streams (stream, owner_read_seq, owner_read_at) VALUES (?, ?, ?)
      ON CONFLICT(stream) DO UPDATE SET owner_read_seq = MAX(COALESCE(streams.owner_read_seq, -1), excluded.owner_read_seq), owner_read_at = excluded.owner_read_at`)
      .run(stream, seq, at === undefined ? new Date().toISOString() : iso(at));
  }

  ownerReadSeq(stream: string): number | undefined {
    const r = this.db.prepare('SELECT owner_read_seq FROM streams WHERE stream = ?').get(stream) as any;
    return r?.owner_read_seq ?? undefined;
  }

  streamInfo(stream: string): { kind?: StreamKind; name?: string; ownerReadSeq?: number } {
    const r = this.db.prepare('SELECT * FROM streams WHERE stream = ?').get(stream) as any;
    return r ? { kind: r.kind ?? undefined, name: r.name ?? undefined, ownerReadSeq: r.owner_read_seq ?? undefined } : {};
  }

  /** stream ごとの歯抜け（seq がある発言の、最小から最大までに無い番号の数） */
  gaps(stream?: string): Array<{ stream: string; missing: number; firstMissing?: number }> {
    const streams = stream ? [stream] : (this.db.prepare('SELECT DISTINCT stream FROM items WHERE seq IS NOT NULL').all() as any[]).map((r) => r.stream);
    const out: Array<{ stream: string; missing: number; firstMissing?: number }> = [];
    for (const s of streams) {
      const seqs = (this.db.prepare('SELECT seq FROM items WHERE stream = ? AND seq IS NOT NULL ORDER BY seq').all(s) as any[]).map((r) => r.seq as number);
      let missing = 0, firstMissing: number | undefined;
      for (let k = 1; k < seqs.length; k++) {
        const d = seqs[k] - seqs[k - 1] - 1;
        if (d > 0) { missing += d; firstMissing ??= seqs[k - 1] + 1; }
      }
      if (missing) out.push({ stream: s, missing, firstMissing });
    }
    return out;
  }

  /** AI がまだ読んでいない発言（新しい順） */
  unread(opt: { forMeOnly?: boolean; selfStreams?: string[]; limit?: number } = {}): LedgerItem[] {
    const limit = Math.min(Math.max(opt.limit ?? 50, 1), 500);
    const self = opt.selfStreams ?? [];
    const cond = opt.forMeOnly ? `AND (to_me = 1 OR reply_to_me = 1 OR to_all = 1 OR stream IN (${self.map(() => '?').join(',') || "''"}))` : '';
    const rows = this.db.prepare(`SELECT * FROM items WHERE ai_read_at IS NULL AND mine = 0 AND recalled = 0 ${cond} ORDER BY at DESC LIMIT ?`)
      .all(...(opt.forMeOnly ? self : []), limit);
    return rows.map(rowToItem);
  }

  countUnread(): number {
    return (this.db.prepare('SELECT COUNT(*) n FROM items WHERE ai_read_at IS NULL AND mine = 0 AND recalled = 0').get() as any).n;
  }

  /**
   * 1 件を、前の数件（流れ）と返信先と一緒に読む。読んだら AI が読んだ印を付ける。
   * 前の発言に番号の抜けがあれば contextGap を立てる（流れが欠けている）。
   */
  read(stream: string, id: string, context = 5): { item: LedgerItem; before: LedgerItem[]; replyTo?: LedgerItem; contextGap: boolean } | undefined {
    const item = this.get(stream, id);
    if (!item) return undefined;
    const before = (this.db.prepare('SELECT * FROM items WHERE stream = ? AND (at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?')
      .all(stream, item.at, item.at, id, Math.min(Math.max(context, 0), 50)) as any[]).map(rowToItem).reverse();
    let contextGap = false;
    const chain = [...before, item].filter((x) => x.seq !== undefined).map((x) => x.seq!);
    for (let k = 1; k < chain.length; k++) if (chain[k] - chain[k - 1] > 1) contextGap = true;
    if (item.seq !== undefined && before.length < context && item.seq > 0) {
      // 台帳の先頭より前があるはずなのに無い
      const minSeq = (this.db.prepare('SELECT MIN(seq) m FROM items WHERE stream = ?').get(stream) as any).m;
      if (minSeq !== null && minSeq > 1 && before.length < context) contextGap = true;
    }
    const replyTo = item.replyTo ? this.get(stream, item.replyTo.id) : undefined;
    this.db.prepare('UPDATE items SET ai_read_at = ? WHERE stream = ? AND id = ? AND ai_read_at IS NULL').run(new Date().toISOString(), stream, id);
    return { item: this.get(stream, id)!, before, replyTo, contextGap };
  }

  /**
   * ある stream の発言を、時刻の順に並べてページごとに返す（読んだ印は付けない）。
   * cursor は前のページの next をそのまま渡す。最初のページは before / after（ISO の時刻か seq）で始める。
   * 同じ時刻の発言があっても飛ばさないよう、並びと位置は (時刻, id) の組で持つ。
   */
  list(stream: string, opt: { order?: 'desc' | 'asc'; limit?: number; cursor?: string; before?: string | number; after?: string | number } = {}): { items: LedgerItem[]; next?: string } {
    const order = opt.order === 'asc' ? 'asc' : 'desc';
    const limit = Math.min(Math.max(opt.limit ?? 100, 1), 1000);
    const where: string[] = ['stream = ?'];
    const args: Array<string | number> = [stream];
    if (opt.cursor) {
      const i = opt.cursor.indexOf('|');
      if (i < 0) throw new Error(`cursor の形が違います（前のページの next をそのまま渡してください）: ${opt.cursor}`);
      const at = opt.cursor.slice(0, i), id = opt.cursor.slice(i + 1);
      where.push(order === 'desc' ? '(at < ? OR (at = ? AND id < ?))' : '(at > ? OR (at = ? AND id > ?))');
      args.push(at, at, id);
    }
    const bound = (v: string | number, op: '<' | '>') => {
      if (typeof v === 'number' || /^\d+$/.test(String(v))) { where.push(`seq ${op} ?`); args.push(Number(v)); }
      else { where.push(`at ${op} ?`); args.push(iso(v)); }
    };
    if (opt.before !== undefined) bound(opt.before, '<');
    if (opt.after !== undefined) bound(opt.after, '>');
    const dir = order === 'desc' ? 'DESC' : 'ASC';
    const rows = this.db.prepare(`SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY at ${dir}, id ${dir} LIMIT ?`).all(...args, limit) as any[];
    const items = rows.map(rowToItem);
    const last = items.at(-1);
    return { items, next: items.length === limit && last ? `${last.at}|${last.id}` : undefined };
  }

  /** 全文検索（新しい順）。3 文字以上は trigram、2 文字以下は LIKE */
  search(q: string, opt: { stream?: string; limit?: number } = {}): LedgerItem[] {
    const limit = Math.min(Math.max(opt.limit ?? 50, 1), 500);
    const s = q.trim();
    if (!s) return [];
    let rows: any[];
    if ([...s].length >= 3) {
      const phrase = '"' + s.replaceAll('"', '""') + '"';
      rows = this.db.prepare(`SELECT i.* FROM items_fts f JOIN fts_map m ON m.fts_rowid = f.rowid JOIN items i ON i.stream = m.stream AND i.id = m.id
        WHERE items_fts MATCH ? ${opt.stream ? 'AND i.stream = ?' : ''} ORDER BY i.at DESC LIMIT ?`)
        .all(...[phrase, ...(opt.stream ? [opt.stream] : []), limit]);
    } else {
      const like = '%' + s.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      rows = this.db.prepare(`SELECT * FROM items WHERE (text LIKE ? ESCAPE '\\' OR stream_name LIKE ? ESCAPE '\\' OR author_name LIKE ? ESCAPE '\\')
        ${opt.stream ? 'AND stream = ?' : ''} ORDER BY at DESC LIMIT ?`)
        .all(...[like, like, like, ...(opt.stream ? [opt.stream] : []), limit]);
    }
    return rows.map(rowToItem);
  }

  /** days 日より古い発言を消す（今日を 1 日目と数える）。見たことのある組（seen）は残す */
  prune(days: number | undefined, now = new Date()): number {
    if (!days || days <= 0) return 0;
    const keepFrom = new Date(now.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const old = this.db.prepare('SELECT stream, id FROM items WHERE at < ?').all(keepFrom) as any[];
    this.db.exec('BEGIN');
    try {
      for (const r of old) {
        const m = this.db.prepare('SELECT fts_rowid FROM fts_map WHERE stream = ? AND id = ?').get(r.stream, r.id) as any;
        if (m) { this.db.prepare('DELETE FROM items_fts WHERE rowid = ?').run(m.fts_rowid); this.db.prepare('DELETE FROM fts_map WHERE stream = ? AND id = ?').run(r.stream, r.id); }
      }
      this.db.prepare('DELETE FROM items WHERE at < ?').run(keepFrom);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return old.length;
  }
}
