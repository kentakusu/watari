// CDP をパイプ（--remote-debugging-pipe）で話す小さな client。
// ポートを開けないので、Chrome を起こしたこのプロセスだけが窓を操れる。
import type { Readable, Writable } from 'node:stream';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string };
type Listener = (params: any, sessionId?: string) => void;

export class Cdp {
  #out: Writable;
  #buf = '';
  #id = 0;
  #pending = new Map<number, Pending>();
  #listeners = new Map<string, Set<Listener>>();
  #closed = false;

  constructor(toChrome: Writable, fromChrome: Readable) {
    this.#out = toChrome;
    fromChrome.on('data', (d: Buffer) => this.#onData(d));
    fromChrome.on('close', () => this.#onClose());
  }

  get closed(): boolean { return this.#closed; }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    if (this.#closed) return Promise.reject(new Error(`CDP は閉じています（${method}）`));
    const id = ++this.#id;
    const msg: any = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#out.write(JSON.stringify(msg) + '\0');
    });
  }

  on(method: string, fn: Listener): () => void {
    let set = this.#listeners.get(method);
    if (!set) { set = new Set(); this.#listeners.set(method, set); }
    set.add(fn);
    return () => set!.delete(fn);
  }

  #onData(d: Buffer): void {
    this.#buf += d.toString('utf8');
    let i: number;
    while ((i = this.#buf.indexOf('\0')) >= 0) {
      const raw = this.#buf.slice(0, i);
      this.#buf = this.#buf.slice(i + 1);
      const msg = JSON.parse(raw);
      if (typeof msg.id === 'number') {
        const p = this.#pending.get(msg.id);
        if (!p) continue;
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
      }
    }
  }

  #onClose(): void {
    this.#closed = true;
    for (const p of this.#pending.values()) p.reject(new Error(`Chrome が閉じました（${p.method}）`));
    this.#pending.clear();
  }
}
