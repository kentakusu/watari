// 渡の芯: 所属ごとの Chrome・セッションごとの窓・拡張。
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, type Browser } from './chrome.ts';
import { BINDING, WORLD, pageScript, reconfigureExpression, siteMatches, type InjectConfig, type WatchDecl } from './inject.ts';

export type WatchSpec = { name: string; selector: string; read?: string };

export type WatchEvent = {
  watch: string;
  value: string | null;
  previous: string | null | undefined;
  url: string;
};

export type Key = 'Enter' | 'Backspace' | 'Tab' | 'Escape';

/** 拡張に渡す、窓を操る道具。 */
export type WindowApi = {
  session: string;
  label: string;
  /** 最初に当たる要素のテキスト。無ければ null */
  read(selector: string): Promise<string | null>;
  /** 当たる要素すべてのテキスト（画面に描かれているものだけ） */
  readAll(selector: string): Promise<string[]>;
  /** 当たる要素すべての属性 */
  attrAll(selector: string, name: string): Promise<Array<string | null>>;
  /** 要素が出てくるまで待つ。出てこなければ NotFound */
  waitFor(selector: string, ms?: number): Promise<void>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  press(key: Key, modifiers?: number): Promise<void>;
  /** 拡張の notifyTo（無ければ窓のセッション）へ知らせる */
  notify(text: string): Promise<void>;
};

export type Extension = {
  name: string;
  sites: string[];
  watch: WatchSpec[];
  /** 通知の宛先（所属/名前）。省くと、その窓のセッション */
  notifyTo?: string;
  onChange(e: WatchEvent, w: WindowApi): Promise<void> | void;
};

export type Notifier = (session: string, text: string) => Promise<void>;

export type AffiliationOptions = {
  name: string;
  home: string;
  notifier: Notifier;
  headless?: boolean;
  /** 見張りの要素が見つからないとき、これだけ待っても見つからなければ知らせる */
  missingGraceMs?: number;
};

export class NotFound extends Error {}

const now = () => new Date().toISOString();

export class Affiliation {
  readonly name: string;
  readonly home: string;
  readonly notifier: Notifier;
  readonly missingGraceMs: number;
  #headless: boolean;
  #extensions: Extension[] = [];
  browser?: Browser;
  windows = new Map<string, SessionWindow>();
  startedAt = '';
  #stopping = false;
  /** 人が窓を閉じたなど、窓の顔ぶれが変わったとき（止めている最中は呼ばない） */
  onWindowsChanged?: () => void;

  constructor(opts: AffiliationOptions) {
    this.name = opts.name;
    this.home = opts.home;
    this.notifier = opts.notifier;
    this.missingGraceMs = opts.missingGraceMs ?? 10000;
    this.#headless = !!opts.headless;
    mkdirSync(join(this.home, 'log'), { recursive: true });
  }

  get extensions(): readonly Extension[] { return this.#extensions; }
  get running(): boolean { return !!this.browser && !this.browser.cdp.closed; }

  log(rec: object): void {
    const line = JSON.stringify({ at: now(), affiliation: this.name, ...rec });
    try {
      appendFileSync(join(this.home, 'log', `${this.name}.jsonl`), line + '\n');
    } catch (e: any) {
      // 記録が書けなくても渡は止めない。ただし黙らず標準エラーに出す
      process.stderr.write(`渡: 記録を書けませんでした（${e?.code ?? e}）: ${line}\n`);
    }
  }

  async start(): Promise<void> {
    this.browser = await launchChrome({ profileDir: join(this.home, 'profiles', this.name), headless: this.#headless });
    this.startedAt = now();
    this.log({ type: 'chrome-started', pid: this.browser.process.pid, waitedForLeftovers: this.browser.leftovers.waitedFor });
    this.browser.process.once('exit', (code) => this.log({ type: 'chrome-exited', code }));
    // 人が窓を閉じたら、そのセッションの窓を一覧から外す
    this.browser.cdp.on('Target.targetDestroyed', (p) => {
      if (this.#stopping) return;
      for (const [s, w] of this.windows) if (w.targetId === p.targetId) { this.windows.delete(s); this.log({ type: 'window-closed', session: s }); this.onWindowsChanged?.(); }
    });
    await this.browser.cdp.send('Target.setDiscoverTargets', { discover: true });
  }

  /** 拡張を差し替える。開いている窓の見張りもその場で変わる（ページは読み直さない）。 */
  async setExtensions(exts: Extension[]): Promise<void> {
    this.#extensions = [...exts];
    for (const w of this.windows.values()) await w.applyExtensions();
  }

  async openWindow(session: string, url: string, label = session): Promise<SessionWindow> {
    if (!this.browser) throw new Error('先に start() を呼んでください');
    const existing = this.windows.get(session);
    if (existing) { await existing.navigate(url); return existing; }
    const w = new SessionWindow(this, session, label);
    await w.open(url);
    this.windows.set(session, w);
    return w;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.browser?.close();
    this.log({ type: 'stopped' });
  }
}

export class SessionWindow {
  readonly session: string;
  #label: string;
  #aff: Affiliation;
  targetId = '';
  #sid = '';
  #ctx = 0;
  #scriptId = '';
  #touching = false;
  #touchWaiters: Array<() => void> = [];
  #queue: Promise<unknown> = Promise.resolve();
  lastEventAt = '';
  url = '';

  constructor(aff: Affiliation, session: string, label: string) {
    this.#aff = aff;
    this.session = session;
    this.#label = label;
  }

  get cdp() { return this.#aff.browser!.cdp; }
  get sessionId() { return this.#sid; }
  get touching() { return this.#touching; }
  get label() { return this.#label; }

  #injectConfig(): InjectConfig {
    const watches: WatchDecl[] = this.#aff.extensions.flatMap((e) => e.watch.map((w) => ({ ...w, ext: e.name, sites: e.sites })));
    return { label: this.#label, watches, missingGraceMs: this.#aff.missingGraceMs };
  }

  async open(url: string): Promise<void> {
    const cdp = this.cdp;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    this.targetId = targetId;
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.#sid = sessionId;

    cdp.on('Runtime.executionContextCreated', (p, sid) => {
      if (sid === this.#sid && p.context.name === WORLD && p.context.auxData?.isDefault === false && p.context.auxData?.frameId === this.targetId) this.#ctx = p.context.id;
    });
    cdp.on('Runtime.bindingCalled', (p, sid) => {
      if (sid !== this.#sid || p.name !== BINDING) return;
      let msg: any;
      try { msg = JSON.parse(p.payload); } catch { return; }
      this.#onMessage(msg);
    });
    cdp.on('Page.frameNavigated', (p, sid) => { if (sid === this.#sid && !p.frame.parentId) this.url = p.frame.url; });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    // 背景の窓でも入力が通るように「前面にある」と思わせる
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    await cdp.send('Runtime.addBinding', { name: BINDING, executionContextName: WORLD }, sessionId);
    await this.#installScript();
    await cdp.send('Page.navigate', { url }, sessionId);
    this.url ||= url;
    this.#aff.log({ type: 'window-opened', session: this.session, url, extensions: this.#aff.extensions.map((e) => e.name) });
  }

  async #installScript(): Promise<void> {
    if (this.#scriptId) await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.#scriptId }, this.#sid);
    const r = await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: pageScript(this.#injectConfig()), worldName: WORLD }, this.#sid);
    this.#scriptId = r.identifier;
  }

  /** 拡張の出し入れ・名札の変更を、開いている窓に効かせる。 */
  async applyExtensions(): Promise<void> {
    await this.#installScript();
    if (this.#ctx) await this.#eval(reconfigureExpression(this.#injectConfig())).catch(() => {});
    this.#aff.log({ type: 'extensions-applied', session: this.session, extensions: this.#aff.extensions.map((e) => e.name) });
  }

  async setLabel(label: string): Promise<void> {
    this.#label = label;
    await this.applyExtensions();
  }

  async navigate(url: string): Promise<void> {
    await this.#serial(() => this.cdp.send('Page.navigate', { url }, this.#sid));
    this.#aff.log({ type: 'navigate', session: this.session, url });
  }

  async focus(): Promise<void> {
    await this.cdp.send('Target.activateTarget', { targetId: this.targetId });
  }

  async close(): Promise<void> {
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId });
  }

  /** 人が「今触ってる」を押したのと同じ。トレイと試験から使う。 */
  setTouching(on: boolean): void {
    this.#touching = on;
    this.#aff.log({ type: 'touch', session: this.session, on });
    if (this.#ctx) this.#eval(`globalThis.__watariShowTouching && globalThis.__watariShowTouching(${on})`).catch(() => {});
    if (!on) { for (const f of this.#touchWaiters.splice(0)) f(); }
  }

  #onMessage(msg: any): void {
    this.lastEventAt = now();
    if (msg.type === 'touch') {
      this.#touching = !!msg.on;
      this.#aff.log({ type: 'touch', session: this.session, on: this.#touching, by: 'human' });
      if (!this.#touching) { for (const f of this.#touchWaiters.splice(0)) f(); }
      return;
    }
    if (msg.type === 'ready') { this.#aff.log({ type: 'page-ready', session: this.session, url: msg.url, watches: msg.watches }); return; }
    if (msg.type !== 'watch') return;
    const ext = this.#aff.extensions.find((e) => e.name === msg.ext);
    // 宣言していないサイトの出来事は拡張に渡さない（窓の中の判定に加えて、ここでも確かめる）
    if (!ext || !siteMatches(ext.sites, msg.url)) return;
    this.#aff.log({ type: 'watch', session: this.session, ext: ext.name, watch: msg.name, value: msg.value, previous: msg.previous, missing: msg.missing, url: msg.url });
    // 出来事と外からの操作は、1 つずつ順に処理する（操作どうしがぶつからないように）
    this.#serial(() => this.#dispatch(ext, msg));
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #dispatch(ext: Extension, msg: any): Promise<void> {
    const api = this.#api(ext);
    if (msg.missing) {
      // 見つからないことを黙らせない（「何も来ていない」と区別するため）
      await api.notify(`【渡 ${ext.name}】見張っている「${msg.name}」が画面に見つかりません（サイトの作りが変わったか、まだ表示されていないか、ログインが切れたかもしれません）: ${msg.url}`).catch(() => {});
      return;
    }
    try {
      await ext.onChange({ watch: msg.name, value: msg.value, previous: msg.previous ?? undefined, url: msg.url }, api);
    } catch (e: any) {
      this.#aff.log({ type: 'extension-error', session: this.session, ext: ext.name, error: String(e?.stack ?? e) });
      await api.notify(`【渡 ${ext.name}】拡張が失敗しました: ${e?.message ?? e}`).catch(() => {});
    }
  }

  async #waitUntilFree(): Promise<void> {
    if (!this.#touching) return;
    this.#aff.log({ type: 'waiting-for-human', session: this.session });
    await new Promise<void>((r) => this.#touchWaiters.push(r));
  }

  async #eval(expression: string): Promise<any> {
    if (!this.#ctx) throw new Error('窓の中の見張りがまだ立っていません（ページを読み込み中かもしれません）');
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

  // ---- 窓を操る（拡張と外からの両方が使う。外からは #serial を通す） ----

  async #read(selector: string): Promise<string | null> {
    return this.#eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.textContent || '').trim() : null; })()`);
  }

  async #mouse(x: number, y: number): Promise<void> {
    const cdp = this.cdp, sid = this.#sid;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sid);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid);
  }

  async #click(selector: string): Promise<void> {
    await this.#waitUntilFree();
    const { x, y } = await this.#center(selector);
    await this.#mouse(x, y);
  }

  async #type(selector: string, text: string): Promise<void> {
    await this.#waitUntilFree();
    const { x, y } = await this.#center(selector);
    await this.#mouse(x, y);
    await this.cdp.send('Input.insertText', { text }, this.#sid);
  }

  async #press(key: Key, modifiers = 0): Promise<void> {
    await this.#waitUntilFree();
    const keys: Record<Key, { code: string; keyCode: number; text?: string }> = {
      Enter: { code: 'Enter', keyCode: 13, text: '\r' },
      Backspace: { code: 'Backspace', keyCode: 8 },
      Tab: { code: 'Tab', keyCode: 9 },
      Escape: { code: 'Escape', keyCode: 27 },
    };
    const k = keys[key];
    if (!k) throw new Error(`押せないキーです: ${key}`);
    await this.cdp.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', key, code: k.code, windowsVirtualKeyCode: k.keyCode, text: modifiers ? undefined : k.text, modifiers }, this.#sid);
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers }, this.#sid);
  }

  #logAct(by: string, rec: object): void { this.#aff.log({ session: this.session, by, ...rec }); }

  /** 外（MCP・トレイ）から使う道具。拡張の動きと順番に並ぶ。 */
  readonly act = {
    read: (selector: string) => this.#serial(() => this.#read(selector)),
    click: (selector: string) => this.#serial(async () => { await this.#click(selector); this.#logAct('outside', { type: 'click', selector }); }),
    type: (selector: string, text: string) => this.#serial(async () => { await this.#type(selector, text); this.#logAct('outside', { type: 'type', selector, length: text.length }); }),
    press: (key: Key, modifiers = 0) => this.#serial(async () => { await this.#press(key, modifiers); this.#logAct('outside', { type: 'press', key, modifiers }); }),
    info: (maxText = 4000) => this.#serial(async () => {
      const r = await this.#eval(`({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, ${Number(maxText)}) })`);
      return { ...r, touching: this.#touching, label: this.#label, lastEventAt: this.lastEventAt };
    }),
    screenshot: () => this.#serial(async () => (await this.cdp.send('Page.captureScreenshot', { format: 'png' }, this.#sid)).data as string),
  };

  /** 拡張に渡す道具。拡張の処理はもう列の中にいるので、#serial は通さない。 */
  #api(extension: Extension): WindowApi {
    const ext = extension.name;
    const log = (rec: object) => this.#logAct(ext, { ext, ...rec });
    const to = extension.notifyTo ?? this.session;
    return {
      session: this.session,
      label: this.#label,
      read: (selector) => this.#read(selector),
      readAll: (selector) => this.#eval(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => (el.textContent || '').trim())`),
      attrAll: (selector, name) => this.#eval(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => el.getAttribute(${JSON.stringify(name)}))`),
      waitFor: async (selector, ms = 10000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          if (await this.#eval(`!!document.querySelector(${JSON.stringify(selector)})`).catch(() => false)) return;
          await new Promise((r) => setTimeout(r, 200));
        }
        throw new NotFound(`${ms}ms 待っても出てきません: ${selector}`);
      },
      click: async (selector) => { await this.#click(selector); log({ type: 'click', selector }); },
      type: async (selector, text) => { await this.#type(selector, text); log({ type: 'type', selector, length: text.length }); },
      press: async (key, modifiers = 0) => { await this.#press(key, modifiers); log({ type: 'press', key, modifiers }); },
      notify: async (text) => {
        log({ type: 'notify', to, text });
        try {
          await this.#aff.notifier(to, text);
        } catch (e: any) {
          log({ type: 'notify-failed', error: String(e?.message ?? e) });
          throw e;
        }
      },
    };
  }
}
