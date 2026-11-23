// 渡の芯: 所属ごとの Chrome・セッションごとの窓・拡張。
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, type Browser } from './chrome.ts';
import { BINDING, WORLD, pageScript, siteMatches, type WatchDecl } from './inject.ts';

export type WatchSpec = { name: string; selector: string; read?: string };

export type WatchEvent = {
  watch: string;
  value: string | null;
  previous: string | null | undefined;
  url: string;
};

/** 拡張に渡す、窓を操る道具。 */
export type WindowApi = {
  session: string;
  label: string;
  read(selector: string): Promise<string | null>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  press(key: 'Enter' | 'Backspace' | 'Tab' | 'Escape', modifiers?: number): Promise<void>;
  notify(text: string): Promise<void>;
};

export type Extension = {
  name: string;
  sites: string[];
  watch: WatchSpec[];
  onChange(e: WatchEvent, w: WindowApi): Promise<void> | void;
};

export type Notifier = (session: string, text: string) => Promise<void>;

export type AffiliationOptions = {
  name: string;
  home: string;
  notifier: Notifier;
  headless?: boolean;
};

export class NotFound extends Error {}

const now = () => new Date().toISOString();

export class Affiliation {
  readonly name: string;
  readonly home: string;
  readonly notifier: Notifier;
  #headless: boolean;
  browser?: Browser;
  windows = new Map<string, SessionWindow>();

  constructor(opts: AffiliationOptions) {
    this.name = opts.name;
    this.home = opts.home;
    this.notifier = opts.notifier;
    this.#headless = !!opts.headless;
    mkdirSync(join(this.home, 'log'), { recursive: true });
  }

  log(rec: object): void {
    appendFileSync(join(this.home, 'log', `${this.name}.jsonl`), JSON.stringify({ at: now(), affiliation: this.name, ...rec }) + '\n');
  }

  async start(): Promise<void> {
    this.browser = await launchChrome({ profileDir: join(this.home, 'profiles', this.name), headless: this.#headless });
    this.log({ type: 'chrome-started', pid: this.browser.process.pid });
    this.browser.process.once('exit', (code) => this.log({ type: 'chrome-exited', code }));
  }

  async openWindow(session: string, url: string, extensions: Extension[], label = session): Promise<SessionWindow> {
    if (!this.browser) throw new Error('先に start() を呼んでください');
    if (this.windows.has(session)) throw new Error(`セッション ${session} の窓はもう開いています`);
    const w = new SessionWindow(this, session, label, extensions);
    await w.open(url);
    this.windows.set(session, w);
    return w;
  }

  async stop(): Promise<void> {
    await this.browser?.close();
    this.log({ type: 'stopped' });
  }
}

export class SessionWindow {
  readonly session: string;
  readonly label: string;
  #aff: Affiliation;
  #exts: Extension[];
  #targetId = '';
  #sid = '';
  #ctx = 0;
  #touching = false;
  #touchWaiters: Array<() => void> = [];
  #queue: Promise<void> = Promise.resolve();
  lastEventAt = '';

  constructor(aff: Affiliation, session: string, label: string, exts: Extension[]) {
    this.#aff = aff;
    this.session = session;
    this.label = label;
    this.#exts = exts;
  }

  get cdp() { return this.#aff.browser!.cdp; }
  get sessionId() { return this.#sid; }
  get touching() { return this.#touching; }

  async open(url: string): Promise<void> {
    const cdp = this.cdp;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    this.#targetId = targetId;
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.#sid = sessionId;

    cdp.on('Runtime.executionContextCreated', (p, sid) => {
      if (sid === this.#sid && p.context.name === WORLD && p.context.auxData?.isDefault === false) this.#ctx = p.context.id;
    });
    cdp.on('Runtime.bindingCalled', (p, sid) => {
      if (sid !== this.#sid || p.name !== BINDING) return;
      let msg: any;
      try { msg = JSON.parse(p.payload); } catch { return; }
      this.#onMessage(msg);
    });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    // 背景の窓でも入力が通るように「前面にある」と思わせる
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    await cdp.send('Runtime.addBinding', { name: BINDING, executionContextName: WORLD }, sessionId);
    const watches: WatchDecl[] = this.#exts.flatMap((e) => e.watch.map((w) => ({ ...w, ext: e.name, sites: e.sites })));
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: pageScript({ label: this.label, watches }), worldName: WORLD }, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    this.#aff.log({ type: 'window-opened', session: this.session, url, extensions: this.#exts.map((e) => e.name) });
  }

  /** 人が「今触ってる」を押したのと同じ。試験と、トレイからの操作に使う。 */
  setTouching(on: boolean): void {
    this.#touching = on;
    this.#aff.log({ type: 'touch', session: this.session, on });
    if (!on) { for (const f of this.#touchWaiters.splice(0)) f(); }
  }

  #onMessage(msg: any): void {
    this.lastEventAt = now();
    if (msg.type === 'touch') { this.setTouching(!!msg.on); return; }
    if (msg.type === 'ready') { this.#aff.log({ type: 'page-ready', session: this.session, url: msg.url, watches: msg.watches }); return; }
    if (msg.type !== 'watch') return;
    const ext = this.#exts.find((e) => e.name === msg.ext);
    // 宣言していないサイトの出来事は拡張に渡さない（窓の中の判定に加えて、ここでも確かめる）
    if (!ext || !siteMatches(ext.sites, msg.url)) return;
    this.#aff.log({ type: 'watch', session: this.session, ext: ext.name, watch: msg.name, value: msg.value, previous: msg.previous, missing: msg.missing, url: msg.url });
    // 出来事は 1 つずつ順に処理する（拡張の操作どうしがぶつからないように）
    this.#queue = this.#queue.then(() => this.#dispatch(ext, msg));
  }

  async #dispatch(ext: Extension, msg: any): Promise<void> {
    const api = this.#api(ext);
    if (msg.missing) {
      // 見つからないことを黙らせない（「何も来ていない」と区別するため）
      await api.notify(`【渡 ${ext.name}】見張っている「${msg.name}」が画面に見つかりません（サイトの作りが変わったか、まだ表示されていないか、ログインが切れたかもしれません）: ${msg.url}`);
      return;
    }
    try {
      await ext.onChange({ watch: msg.name, value: msg.value, previous: msg.previous ?? undefined, url: msg.url }, api);
    } catch (e: any) {
      this.#aff.log({ type: 'extension-error', session: this.session, ext: ext.name, error: String(e?.stack ?? e) });
      await api.notify(`【渡 ${ext.name}】拡張が失敗しました: ${e?.message ?? e}`);
    }
  }

  async #waitUntilFree(): Promise<void> {
    if (!this.#touching) return;
    this.#aff.log({ type: 'waiting-for-human', session: this.session });
    await new Promise<void>((r) => this.#touchWaiters.push(r));
  }

  async #eval(expression: string): Promise<any> {
    if (!this.#ctx) throw new Error('窓の中の見張りがまだ立っていません');
    const r = await this.cdp.send('Runtime.evaluate', { expression, contextId: this.#ctx, returnByValue: true, awaitPromise: true }, this.#sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  async #center(selector: string): Promise<{ x: number; y: number }> {
    const sel = JSON.stringify(selector);
    const r = await this.#eval(`(() => { const el = document.querySelector(${sel}); if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' }); const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height }; })()`);
    if (!r) throw new NotFound(`要素が見つかりません: ${selector}`);
    if (!r.w || !r.h) throw new NotFound(`要素が見えていません（大きさが 0）: ${selector}`);
    return r;
  }

  #api(ext: Extension): WindowApi {
    const cdp = this.cdp;
    const sid = () => this.#sid;
    const log = (rec: object) => this.#aff.log({ session: this.session, ext: ext.name, ...rec });
    const mouse = async (x: number, y: number) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sid());
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid());
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid());
    };
    const keys: Record<string, { code: string; keyCode: number; text?: string }> = {
      Enter: { code: 'Enter', keyCode: 13, text: '\r' },
      Backspace: { code: 'Backspace', keyCode: 8 },
      Tab: { code: 'Tab', keyCode: 9 },
      Escape: { code: 'Escape', keyCode: 27 },
    };
    return {
      session: this.session,
      label: this.label,
      read: async (selector) => {
        const sel = JSON.stringify(selector);
        return this.#eval(`(() => { const el = document.querySelector(${sel}); return el ? (el.textContent || '').trim() : null; })()`);
      },
      click: async (selector) => {
        await this.#waitUntilFree();
        const { x, y } = await this.#center(selector);
        await mouse(x, y);
        log({ type: 'click', selector });
      },
      type: async (selector, text) => {
        await this.#waitUntilFree();
        const { x, y } = await this.#center(selector);
        await mouse(x, y);
        await cdp.send('Input.insertText', { text }, sid());
        log({ type: 'type', selector, length: text.length });
      },
      press: async (key, modifiers = 0) => {
        await this.#waitUntilFree();
        const k = keys[key];
        await cdp.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', key, code: k.code, windowsVirtualKeyCode: k.keyCode, text: modifiers ? undefined : k.text, modifiers }, sid());
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers }, sid());
        log({ type: 'press', key, modifiers });
      },
      notify: async (text) => {
        log({ type: 'notify', text });
        try {
          await this.#aff.notifier(this.session, text);
        } catch (e: any) {
          log({ type: 'notify-failed', error: String(e?.message ?? e) });
          throw e;
        }
      },
    };
  }
}
