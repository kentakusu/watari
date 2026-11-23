// 送る口（関所つき）。Claude が「どの部屋に・どの本文を」預け、拡張が画面で送り、本体が台帳で確かめる。
// - 設定（outbox）で許した部屋にしか送らない。設定が無ければ送る口は閉じている
// - 預けた本文をそのまま 1 回だけ送る（同じ預けを 2 回送らない）
// - 同じ部屋に同じ本文を少し前に送っていれば断る（「確かめられない」のあとに出し直して二重に届くのを防ぐ）
// - 結果は 3 つ: confirmed（台帳に自分の発言として本文が完全一致で入った）／unconfirmed（送れたが確かめられない）／failed（送れなかった）
//   unconfirmed のあとで台帳に入れば confirmed に変える
import type { DatabaseSync } from 'node:sqlite';
import type { LedgerItem } from './ledger.ts';

export type OutboxConfig = {
  /** 送ってよい部屋（stream） */
  allowedStreams?: string[];
  /** 送ってよい部屋の種類（台帳の streamKind） */
  allowedStreamKinds?: string[];
  /** 送ったあと、台帳に入るのを待つ秒数（既定 60） */
  confirmSeconds?: number;
  /** 同じ部屋に同じ本文を、これだけの分のあいだは送り直さない（既定 10） */
  repeatGuardMinutes?: number;
};

export type OutboxStatus = 'pending' | 'sending' | 'unconfirmed' | 'confirmed' | 'failed';

export type OutboxEntry = {
  id: number;
  requestedAt: string;
  by: string;
  stream: string;
  text: string;
  status: OutboxStatus;
  sentAt?: string;
  confirmedAt?: string;
  /** 確かめに使った台帳の発言 */
  confirmedBy?: { stream: string; id: string };
  note?: string;
};

function row(r: any): OutboxEntry {
  const e: OutboxEntry = { id: r.id, requestedAt: r.requested_at, by: r.by_session, stream: r.stream, text: r.text, status: r.status };
  if (r.sent_at) e.sentAt = r.sent_at;
  if (r.confirmed_at) e.confirmedAt = r.confirmed_at;
  if (r.confirmed_stream) e.confirmedBy = { stream: r.confirmed_stream, id: r.confirmed_id };
  if (r.note) e.note = r.note;
  return e;
}

export class Outbox {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, requested_at TEXT NOT NULL, by_session TEXT NOT NULL,
      stream TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, sent_at TEXT, confirmed_at TEXT, confirmed_stream TEXT, confirmed_id TEXT, note TEXT)`);
  }

  get(id: number): OutboxEntry | undefined {
    const r = this.#db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
    return r ? row(r) : undefined;
  }

  recent(limit = 20): OutboxEntry[] {
    return (this.#db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 200)) as any[]).map(row);
  }

  /** 預ける前の関所。通らなければ理由を返す */
  check(cfg: OutboxConfig | undefined, stream: string, text: string, streamKind: string | undefined, opt: { allowRepeat?: boolean } = {}): string | null {
    if (!cfg) return '送る口が設定されていません（config.json の outbox）';
    const okStream = !!cfg.allowedStreams?.includes(stream);
    const okKind = !!streamKind && !!cfg.allowedStreamKinds?.includes(streamKind);
    if (!okStream && !okKind) return `この部屋には送れません（outbox の allowedStreams・allowedStreamKinds に無い）: ${stream}${streamKind ? `（${streamKind}）` : '（部屋の種類は台帳に無い）'}`;
    if (!text.trim()) return '本文が空です';
    if (!opt.allowRepeat) {
      const since = new Date(Date.now() - (cfg.repeatGuardMinutes ?? 10) * 60000).toISOString();
      const dup = this.#db.prepare(`SELECT id, status FROM outbox WHERE stream = ? AND text = ? AND requested_at >= ? AND status != 'failed' ORDER BY id DESC LIMIT 1`).get(stream, text, since) as any;
      if (dup) return `同じ部屋に同じ本文を、少し前に預かっています（id=${dup.id}・${dup.status}）。二重に届くのを防ぐため断りました。本当に送り直すなら allow_repeat を付けてください`;
    }
    return null;
  }

  create(by: string, stream: string, text: string): OutboxEntry {
    const r = this.#db.prepare(`INSERT INTO outbox (requested_at, by_session, stream, text, status) VALUES (?, ?, ?, ?, 'pending')`).run(new Date().toISOString(), by, stream, text);
    return this.get(Number(r.lastInsertRowid))!;
  }

  /** pending → sending。ほかが先に動かしていたら false（同じ預けを 2 回送らない） */
  claim(id: number): boolean {
    return Number(this.#db.prepare(`UPDATE outbox SET status = 'sending', sent_at = ? WHERE id = ? AND status = 'pending'`).run(new Date().toISOString(), id).changes) === 1;
  }

  fail(id: number, note: string): void {
    this.#db.prepare(`UPDATE outbox SET status = 'failed', note = ? WHERE id = ? AND status IN ('pending', 'sending')`).run(note, id);
  }

  /** 待っても台帳に入らなかった */
  unconfirmed(id: number, note: string): void {
    this.#db.prepare(`UPDATE outbox SET status = 'unconfirmed', note = ? WHERE id = ? AND status = 'sending'`).run(note, id);
  }

  /**
   * 台帳に入った自分の発言と照らし合わせ、送ったもの（sending / unconfirmed）と本文が完全一致すれば confirmed にする。
   * 確かめたものを返す。
   */
  matchLedger(items: LedgerItem[]): OutboxEntry[] {
    const done: OutboxEntry[] = [];
    for (const it of items) {
      if (!it.mine || it.text === undefined) continue;
      const cand = this.#db.prepare(`SELECT * FROM outbox WHERE stream = ? AND text = ? AND status IN ('sending', 'unconfirmed') AND sent_at <= ? ORDER BY id LIMIT 1`)
        .get(it.stream, it.text, new Date(Date.parse(it.at) + 120000).toISOString()) as any;
      if (!cand) continue;
      this.#db.prepare(`UPDATE outbox SET status = 'confirmed', confirmed_at = ?, confirmed_stream = ?, confirmed_id = ? WHERE id = ?`).run(new Date().toISOString(), it.stream, it.id, cand.id);
      done.push(this.get(cand.id)!);
    }
    return done;
  }

  counts(): Record<OutboxStatus, number> {
    const out: Record<OutboxStatus, number> = { pending: 0, sending: 0, unconfirmed: 0, confirmed: 0, failed: 0 };
    for (const r of this.#db.prepare('SELECT status, COUNT(*) n FROM outbox GROUP BY status').all() as any[]) out[r.status as OutboxStatus] = r.n;
    return out;
  }
}
