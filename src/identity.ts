// 書き手の見分け（台帳に入れる前に、設定で authorKind・mine を直す）。
// 拡張は「書き手の id・名前・人か Bot か」を素直に入れるだけにし、誰が持ち主の側か・どの Bot を人と同じに扱うかは設定で決める。
// - ownAuthors（id）に当たる書き手 → mine: true（持ち主の側）
// - 自分の 1:1（selfStreams）に出てきた Bot → 持ち主の側の Bot として覚える（台帳に残す）
// - proxyAuthorNames（名前の一部）に当たる Bot → 人と同じに扱う（authorKind: 'human'）。ほかの人の代理の Bot のため
//   （持ち主の側の Bot は先に mine になるので、こちらには当たらない）
import type { DatabaseSync } from 'node:sqlite';
import type { LedgerItemInput } from './ledger.ts';

export type IdentityConfig = {
  /** 持ち主の側の書き手の id */
  ownAuthors?: string[];
  /** 人と同じに扱う Bot の名前の一部（ほかの人の代理の Bot） */
  proxyAuthorNames?: string[];
  /** 自分の 1:1（起こす条件の selfStreams）に出てきた Bot を、持ち主の側として覚えるか（既定 true） */
  learnOwnBotsFromSelfStreams?: boolean;
};

export class Identity {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec('CREATE TABLE IF NOT EXISTS own_authors (author TEXT PRIMARY KEY, learned_at TEXT NOT NULL, from_stream TEXT)');
  }

  learned(): string[] {
    return (this.#db.prepare('SELECT author FROM own_authors ORDER BY learned_at').all() as any[]).map((r) => r.author);
  }

  /** 台帳に入れる前の発言を直した写しを返す（元は変えない）。覚えた書き手も返す */
  apply(items: LedgerItemInput[], cfg: IdentityConfig | undefined, selfStreams: string[]): { items: LedgerItemInput[]; learned: string[] } {
    const learnedNow: string[] = [];
    if (cfg?.learnOwnBotsFromSelfStreams !== false) {
      const add = this.#db.prepare('INSERT OR IGNORE INTO own_authors (author, learned_at, from_stream) VALUES (?, ?, ?)');
      for (const i of items) {
        if (i.authorKind === 'bot' && i.author && selfStreams.includes(i.stream)) {
          if (Number(add.run(i.author, new Date().toISOString(), i.stream).changes) === 1) learnedNow.push(i.author);
        }
      }
    }
    const own = new Set([...(cfg?.ownAuthors ?? []), ...this.learned()]);
    const proxies = cfg?.proxyAuthorNames ?? [];
    const out = items.map((i) => {
      const x = { ...i };
      if (x.author && own.has(x.author)) x.mine = true;
      else if (x.authorKind === 'bot' && x.authorName && proxies.some((n) => n && x.authorName!.includes(n))) x.authorKind = 'human';
      return x;
    });
    return { items: out, learned: learnedNow };
  }
}
