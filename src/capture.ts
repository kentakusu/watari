// 通信の記録。窓に届いた HTTP の応答と WebSocket のメッセージのうち、拡張が宣言したものだけを取る。
// ★要求の見出し（Cookie・Authorization など）は取らない。取るのは URL・方法・状態・本文だけ。
// ★窓の通信を止めたり書き換えたりはしない（止めすぎると、画面が「切れた」とみなして取り直しを増やすことがある）。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cdp } from './cdp.ts';
import { globSource } from './inject.ts';

export type CaptureSpec = {
  /** 記録の名前（拡張の中で一意） */
  name: string;
  /** URL の glob（* だけが特別） */
  url: string;
  /** 取る種類。省くと両方 */
  kinds?: Array<'http' | 'ws'>;
  /** 本文も取るか（既定 true） */
  body?: boolean;
};

export type Capture = {
  at: string;
  session: string;
  ext: string;
  name: string;
  kind: 'http' | 'ws';
  url: string;
  method?: string;
  status?: number;
  /** ws のとき: in＝窓が受け取った／out＝窓が送った */
  dir?: 'in' | 'out';
  mimeType?: string;
  body?: string;
  /** 本文が上限を超えて切ったときの元の長さ */
  truncatedFrom?: number;
  /** 本文が取れなかった理由（取れないことを黙らない） */
  bodyError?: string;
};

export type CaptureRule = CaptureSpec & { ext: string; re: RegExp };

export const MAX_BODY = 1_000_000;

const day = (iso: string) => iso.slice(0, 10);

export function captureDir(home: string, affiliation: string): string {
  return join(home, 'captures', affiliation);
}

export function appendCapture(home: string, affiliation: string, c: Capture): void {
  const dir = captureDir(home, affiliation);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${day(c.at)}.jsonl`), JSON.stringify(c) + '\n');
}

export type CaptureQuery = { name?: string; ext?: string; session?: string; since?: string; contains?: string; limit?: number };

/** 新しい順に探す。since より前の日のファイルは開かない。 */
export function searchCaptures(home: string, affiliation: string, q: CaptureQuery): { items: Capture[]; scannedFiles: number; matched: number } {
  const dir = captureDir(home, affiliation);
  if (!existsSync(dir)) return { items: [], scannedFiles: 0, matched: 0 };
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && (!q.since || f.slice(0, 10) >= day(q.since))).sort().reverse();
  const items: Capture[] = [];
  let matched = 0, scannedFiles = 0;
  for (const f of files) {
    scannedFiles++;
    const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).reverse();
    for (const l of lines) {
      const c = JSON.parse(l) as Capture;
      if (q.since && c.at < q.since) continue;
      if (q.name && c.name !== q.name) continue;
      if (q.ext && c.ext !== q.ext) continue;
      if (q.session && c.session !== q.session) continue;
      if (q.contains && !(c.url.includes(q.contains) || (c.body ?? '').includes(q.contains))) continue;
      matched++;
      if (items.length < limit) items.push(c);
    }
  }
  return { items, scannedFiles, matched };
}

/**
 * 1 つの窓の通信を見て、規則に当たったものを渡す。
 * 規則が 1 つも無いときは Network を有効にしない（余計な負荷をかけない）。
 */
export class NetworkTap {
  #cdp: Cdp;
  #sid: string;
  #rules: CaptureRule[] = [];
  #enabled = false;
  #reqs = new Map<string, { url: string; method: string; status?: number; mimeType?: string; rule?: CaptureRule }>();
  #sockets = new Map<string, string>();
  #off: Array<() => void> = [];
  onCapture: (rule: CaptureRule, c: Omit<Capture, 'at' | 'session' | 'ext' | 'name'>) => void = () => {};

  constructor(cdp: Cdp, sessionId: string) {
    this.#cdp = cdp;
    this.#sid = sessionId;
  }

  #match(url: string, kind: 'http' | 'ws'): CaptureRule | undefined {
    return this.#rules.find((r) => (!r.kinds || r.kinds.includes(kind)) && r.re.test(url));
  }

  async setRules(rules: Array<CaptureSpec & { ext: string }>): Promise<void> {
    this.#rules = rules.map((r) => ({ ...r, re: new RegExp(globSource(r.url)) }));
    if (this.#rules.length && !this.#enabled) await this.#enable();
    else if (!this.#rules.length && this.#enabled) await this.#disable();
  }

  async #enable(): Promise<void> {
    const on = (m: string, fn: (p: any) => void) => this.#off.push(this.#cdp.on(m, (p, sid) => { if (sid === this.#sid) fn(p); }));
    on('Network.requestWillBeSent', (p) => {
      const rule = this.#match(p.request.url, 'http');
      if (rule) this.#reqs.set(p.requestId, { url: p.request.url, method: p.request.method, rule });
    });
    on('Network.responseReceived', (p) => {
      const r = this.#reqs.get(p.requestId);
      if (r) { r.status = p.response.status; r.mimeType = p.response.mimeType; }
    });
    on('Network.loadingFinished', (p) => {
      const r = this.#reqs.get(p.requestId);
      if (!r || !r.rule) return;
      this.#reqs.delete(p.requestId);
      void this.#finishHttp(p.requestId, r);
    });
    on('Network.loadingFailed', (p) => {
      const r = this.#reqs.get(p.requestId);
      if (!r || !r.rule) return;
      this.#reqs.delete(p.requestId);
      this.onCapture(r.rule, { kind: 'http', url: r.url, method: r.method, status: r.status, bodyError: `読み込みに失敗: ${p.errorText}` });
    });
    on('Network.webSocketCreated', (p) => { if (this.#match(p.url, 'ws')) this.#sockets.set(p.requestId, p.url); });
    on('Network.webSocketClosed', (p) => this.#sockets.delete(p.requestId));
    const frame = (dir: 'in' | 'out') => (p: any) => {
      const url = this.#sockets.get(p.requestId);
      if (!url) return;
      const rule = this.#match(url, 'ws');
      if (!rule) return;
      const data = String(p.response?.payloadData ?? '');
      this.onCapture(rule, { kind: 'ws', url, dir, ...this.#body(rule, p.response?.opcode === 2 ? `[binary ${data.length} base64]` : data) });
    };
    on('Network.webSocketFrameReceived', frame('in'));
    on('Network.webSocketFrameSent', frame('out'));
    await this.#cdp.send('Network.enable', { maxPostDataSize: 0 }, this.#sid);
    this.#enabled = true;
  }

  async #disable(): Promise<void> {
    for (const off of this.#off.splice(0)) off();
    this.#reqs.clear();
    this.#sockets.clear();
    await this.#cdp.send('Network.disable', {}, this.#sid).catch(() => {});
    this.#enabled = false;
  }

  #body(rule: CaptureRule, text: string): { body?: string; truncatedFrom?: number } {
    if (rule.body === false) return {};
    if (text.length <= MAX_BODY) return { body: text };
    return { body: text.slice(0, MAX_BODY), truncatedFrom: text.length };
  }

  async #finishHttp(requestId: string, r: { url: string; method: string; status?: number; mimeType?: string; rule?: CaptureRule }): Promise<void> {
    const rule = r.rule!;
    const base = { kind: 'http' as const, url: r.url, method: r.method, status: r.status, mimeType: r.mimeType };
    if (rule.body === false) { this.onCapture(rule, base); return; }
    try {
      const b = await this.#cdp.send('Network.getResponseBody', { requestId }, this.#sid);
      const text = b.base64Encoded ? `[binary ${String(b.body).length} base64]` : String(b.body);
      this.onCapture(rule, { ...base, ...this.#body(rule, text) });
    } catch (e: any) {
      this.onCapture(rule, { ...base, bodyError: e?.message ?? String(e) });
    }
  }
}
