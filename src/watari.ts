// 渡の芯: 所属ごとの Chrome・セッションごとの窓・拡張。
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, type Browser } from './chrome.ts';
import { BINDING, WORLD, pageScript, reconfigureExpression, siteMatches, type InjectConfig, type WatchDecl } from './inject.ts';
import { openState, type ExtensionState } from './state.ts';
import { Ledger, type LedgerItemInput, type PutResult } from './ledger.ts';
import { TriggerEngine, type TriggerConfig } from './triggers.ts';
import { decodeMqtt, MqttJoiner, type MqttPacket } from './mqtt.ts';
import { Outbox, type OutboxConfig, type OutboxEntry } from './outbox.ts';
import { NetworkTap, appendCapture, type Capture, type CaptureRule, type CaptureSpec } from './capture.ts';

export type WatchSpec = { name: string; selector: string; read?: string };

export type WatchEvent = {
  watch: string;
  value: string | null;
  previous: string | null | undefined;
  url: string;
};

export type Key = 'Enter' | 'Backspace' | 'Tab' | 'Escape';

export type ScrollOptions = {
  /** 一覧の中にある要素（そのスクロールできる親を送る。省くとページ全体） */
  within?: string;
  /** 送る回数の上限（既定 60） */
  max?: number;
  /** 1 回に送る量（見えている高さに対する割合・既定 0.8） */
  stepRatio?: number;
  /** 送ったあと待つ時間（既定 500ms） */
  waitMs?: number;
  /** 末尾で、続きの読み込みを待つ時間（既定 1500ms） */
  endWaitMs?: number;
};

export type ScrollResult = { found: boolean; steps: number; reachedEnd: boolean };

/** 拡張に渡す、窓を操る道具。 */
export type WindowApi = {
  session: string;
  label: string;
  /** 最初に当たる要素のテキスト。無ければ null */
  read(selector: string): Promise<string | null>;
  /** 一覧を項目ごとのオブジェクトで読む（fields: '@属性' / 'セレクタ' / 'セレクタ@属性' / '.'） */
  collect(itemSelector: string, fields: Record<string, string>): Promise<Array<Record<string, string | null>>>;
  /** 当たる要素すべてのテキスト（画面に描かれているものだけ） */
  readAll(selector: string): Promise<string[]>;
  /** 当たる要素すべての属性 */
  attrAll(selector: string, name: string): Promise<Array<string | null>>;
  /** 要素が出てくるまで待つ。出てこなければ NotFound */
  waitFor(selector: string, ms?: number): Promise<void>;
  click(selector: string): Promise<void>;
  /**
   * 見えている分しか描かない一覧を、探す要素が出るまで下へたどる。人が「今触ってる」の間は待つ。
   * within: 一覧の中にある要素（そのスクロールできる親を送る。省くとページ全体）
   */
  scrollUntil(selector: string, opt?: ScrollOptions): Promise<ScrollResult>;
  /** 一覧（within のスクロールできる親）を先頭に戻す */
  scrollToTop(within?: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  press(key: Key, modifiers?: number): Promise<void>;
  /** 拡張の notifyTo（無ければ窓のセッション）へ知らせる */
  notify(text: string): Promise<void>;
  /** 取りこぼしたかもしれない数などを報告する（状態に出る。「0 件」を「見ていない」と区別するため） */
  report(r: { gaps?: number; note?: string }): void;
  /** よくある形を開く道具 */
  decode: {
    /** MQTT のパケット（base64）を開く。WebSocket の上の MQTT を読むため */
    /**
     * join に接続の鍵（記録の connection）を渡すと、前のフレームで切れた残りとつなぎ直して開く。
     * どんな入力でも投げない（切れたものは truncated、形が崩れたものは malformed）
     */
    mqtt(base64: string, opt?: { version?: 4 | 5; join?: string }): MqttPacket[];
  };
  /** 拡張の小さな状態（所属と拡張ごと・常駐の再起動をまたいで残る・1MB まで） */
  state: ExtensionState;
  /** 発言の台帳（所属ごと）。put で入れると、新しい発言だけが返り、起こす条件が判定される */
  ledger: {
    /** initial: 最初の一括取り込み（起こさない） */
    put(items: LedgerItemInput[], opt?: { initial?: boolean }): PutResult;
    /** 持ち主がその部屋でどこまで読んだか（それ以下の発言では起こさない） */
    setOwnerRead(stream: string, seq: number, at?: string | number): void;
  };
};

export type Extension = {
  name: string;
  sites: string[];
  watch: WatchSpec[];
  /** 通知の宛先（所属/名前）。省くと、その窓のセッション */
  notifyTo?: string;
  onChange(e: WatchEvent, w: WindowApi): Promise<void> | void;
  /** 取る通信。宣言したものだけが記録され（captures/<所属>/<日付>.jsonl）、onCapture に渡る */
  capture?: CaptureSpec[];
  onCapture?(c: Capture, w: WindowApi): Promise<void> | void;
  /**
   * 預かった本文を、画面でそのまま送る（送る口）。req.text を変えずに送ること。
   * 送れなかったら投げる。送ったことの確かめは本体が台帳で行う（自分の発言として本文が完全一致で入るか）。
   * 動いている間は、同じ窓の拡張のほかの操作は待つ。
   */
  onSend?(req: { id: number; stream: string; text: string }, w: WindowApi): Promise<void>;
};

export type Notifier = (session: string, text: string) => Promise<void>;

export type AffiliationOptions = {
  name: string;
  home: string;
  notifier: Notifier;
  headless?: boolean;
  /** 見張りの要素が見つからないとき、これだけ待っても見つからなければ知らせる */
  missingGraceMs?: number;
  /** この所属の「起こす条件」（呼ぶたびに読むので、設定を書き換えればすぐ効く） */
  triggerConfig?: () => TriggerConfig | undefined;
  /** この所属の送る口の設定（呼ぶたびに読む） */
  outboxConfig?: () => OutboxConfig | undefined;
  /** 閉じるボタンを押されても閉じずに裏で動かす窓か（窓を開くときに聞く） */
  closeToBackground?: (session: string) => boolean;
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
  closeToBackground: (session: string) => boolean;
  /** 人（か外の出来事）が窓を閉じたとき（止めている最中は呼ばない） */
  onWindowClosed?: (w: { session: string; url: string; label: string }) => void;
  /** 渡が止めていないのに Chrome が終わったとき。そのとき開いていた窓を渡す */
  onChromeExited?: (lost: Array<{ session: string; url: string; label: string }>) => void;

  /** この所属の拡張の通知先（重なりなし）。窓が閉じたことなどを知らせる先 */
  notifyTargets(): string[] {
    return [...new Set(this.#extensions.map((e) => e.notifyTo).filter((t): t is string => !!t))];
  }

  constructor(opts: AffiliationOptions) {
    this.name = opts.name;
    this.home = opts.home;
    this.notifier = opts.notifier;
    this.missingGraceMs = opts.missingGraceMs ?? 10000;
    this.#triggerConfig = opts.triggerConfig ?? (() => undefined);
    this.#outboxConfig = opts.outboxConfig ?? (() => undefined);
    this.closeToBackground = opts.closeToBackground ?? (() => false);
    this.#headless = !!opts.headless;
    mkdirSync(join(this.home, 'log'), { recursive: true });
  }

  get extensions(): readonly Extension[] { return this.#extensions; }

  /** フレームをまたぐ MQTT のパケットをつなぎ直すための残り（接続ごと） */
  readonly mqttJoiner = new MqttJoiner();

  #states = new Map<string, ExtensionState>();
  /** 拡張の状態。所属の中で拡張ごとに 1 つ（窓が違っても同じもの） */
  stateFor(ext: string): ExtensionState {
    let s = this.#states.get(ext);
    if (!s) { s = openState(this.home, this.name, ext); this.#states.set(ext, s); }
    return s;
  }
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
    this.browser.process.once('exit', (code) => {
      this.log({ type: 'chrome-exited', code });
      // 渡が止めたのでなく Chrome が終わった（人が窓を全部閉じた・落ちた）。窓は全部なくなっている
      if (!this.#stopping) {
        const lost = [...this.windows.values()].map((w) => ({ session: w.session, url: w.url, label: w.label }));
        this.windows.clear();
        this.onChromeExited?.(lost);
      }
    });
    // 人が窓を閉じたら、そのセッションの窓を一覧から外す
    this.browser.cdp.on('Target.targetDestroyed', (p) => {
      if (this.#stopping) return;
      for (const [s, w] of this.windows) if (w.targetId === p.targetId) {
        this.windows.delete(s);
        this.log({ type: 'window-closed', session: s });
        this.onWindowsChanged?.();
        this.onWindowClosed?.({ session: s, url: w.url, label: w.label });
      }
    });
    await this.browser.cdp.send('Target.setDiscoverTargets', { discover: true });
    await this.#watchWorkers();
  }

  /** 拡張を差し替える。開いている窓の見張りもその場で変わる（ページは読み直さない）。 */
  async setExtensions(exts: Extension[]): Promise<void> {
    this.#extensions = [...exts];
    for (const w of this.windows.values()) await w.applyExtensions();
    for (const t of this.#workers.values()) await t.tap.setRules(this.captureRules()).catch(() => {});
  }

  captureRules(): Array<CaptureSpec & { ext: string }> {
    return this.#extensions.flatMap((e) => (e.capture ?? []).map((c) => ({ ...c, ext: e.name })));
  }

  // ---- 共有ワーカー・サービスワーカーの通信 ----
  // ワーカーは窓とは別の target なので、Chrome 全体で自動でつなぐ。
  // 起動の前で止めてもらい（waitForDebuggerOnStart）、通信の記録を有効にしてから動かす。
  // そうしないと、開いてすぐの WebSocket の接続を取り逃がす。
  #workers = new Map<string, { tap: NetworkTap; type: string; url: string }>();

  async #watchWorkers(): Promise<void> {
    const cdp = this.browser!.cdp;
    cdp.on('Target.attachedToTarget', (p, sid) => {
      if (sid) return; // 窓の中から来たものではなく、Chrome 全体の自動接続だけを扱う
      const type = p.targetInfo.type as string;
      if (type !== 'shared_worker' && type !== 'service_worker') return;
      void this.#onWorker(p.sessionId, type, p.targetInfo.url);
    });
    cdp.on('Target.detachedFromTarget', (p, sid) => { if (!sid) this.#workers.delete(p.sessionId); });
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: 'shared_worker', exclude: false }, { type: 'service_worker', exclude: false }, { exclude: true }],
    });
  }

  async #onWorker(sessionId: string, type: string, url: string): Promise<void> {
    const cdp = this.browser!.cdp;
    try {
      const tap = new NetworkTap(cdp, sessionId);
      tap.onCapture = (rule, c) => this.#onWorkerCapture(type, url, rule, c);
      this.#workers.set(sessionId, { tap, type, url });
      await tap.setRules(this.captureRules());
      this.log({ type: 'worker-attached', worker: type, url });
    } catch (e: any) {
      this.log({ type: 'worker-attach-failed', worker: type, url, error: String(e?.message ?? e) });
    } finally {
      // 何があっても動かす（止めたままにするとサイトが動かなくなる）
      await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
  }

  #onWorkerCapture(type: string, workerUrl: string, rule: CaptureRule, c: Omit<Capture, 'at' | 'session' | 'ext' | 'name'>): void {
    const ext = this.#extensions.find((e) => e.name === rule.ext);
    // ワーカーは窓をまたいで共有される。その拡張の sites に当たる窓に渡す（無ければ記録だけ）
    const win = [...this.windows.values()].find((w) => ext && siteMatches(ext.sites, w.url));
    const full: Capture = { at: now(), session: win?.session ?? `${this.name}/(ワーカー)`, ext: rule.ext, name: rule.name, source: type as Capture['source'], workerUrl, ...c };
    try { appendCapture(this.home, this.name, full); }
    catch (e: any) { this.log({ type: 'capture-write-failed', worker: type, error: String(e?.message ?? e) }); }
    win?.dispatchCapture(full);
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

  #triggerConfig: () => TriggerConfig | undefined;
  #ledger?: Ledger;
  #triggers?: TriggerEngine;
  /** 発言の台帳（初めて使うときに開く） */
  ledger(): Ledger {
    this.#ledger ??= new Ledger(this.home, this.name);
    return this.#ledger;
  }
  #outboxConfig: () => OutboxConfig | undefined;
  #outbox?: Outbox;
  outbox(): Outbox {
    this.#outbox ??= new Outbox(this.ledger().db);
    return this.#outbox;
  }

  /**
   * 送る口: 関所を通し、拡張の onSend で送り、台帳で確かめる。最後の状態を返す（confirmed / unconfirmed / failed）。
   * 関所で断ったときは投げる（預けを作らない）。
   */
  async send(by: string, stream: string, text: string, opt: { allowRepeat?: boolean } = {}): Promise<OutboxEntry> {
    const cfg = this.#outboxConfig();
    const box = this.outbox();
    const refused = box.check(cfg, stream, text, this.ledger().streamInfo(stream).kind, opt);
    if (refused) throw new Error(refused);
    const ext = this.#extensions.find((e) => typeof e.onSend === 'function');
    if (!ext) throw new Error('送る拡張が入っていません（onSend を持つ拡張が無い）');
    const win = [...this.windows.values()].find((w) => siteMatches(ext.sites, w.url));
    if (!win) throw new Error(`拡張 ${ext.name} のサイトを開いている窓がありません`);
    const entry = box.create(by, stream, text);
    this.log({ type: 'send-requested', id: entry.id, by, stream, ext: ext.name, length: text.length });
    if (!box.claim(entry.id)) throw new Error(`預け ${entry.id} は、もう送り始めています`);
    try {
      await win.runSend(ext, { id: entry.id, stream, text });
      this.log({ type: 'send-done', id: entry.id, stream });
    } catch (e: any) {
      box.fail(entry.id, `送れなかった: ${e?.message ?? e}`);
      this.log({ type: 'send-failed', id: entry.id, stream, error: String(e?.message ?? e) });
      return box.get(entry.id)!;
    }
    // 台帳に「自分の発言・本文が完全一致」が入るのを待つ（入れば ledger.put の中で confirmed になる）
    const end = Date.now() + (cfg?.confirmSeconds ?? 60) * 1000;
    while (Date.now() < end && box.get(entry.id)!.status === 'sending') await new Promise((r) => setTimeout(r, 250));
    if (box.get(entry.id)!.status === 'sending') {
      box.unconfirmed(entry.id, `${cfg?.confirmSeconds ?? 60} 秒待っても、台帳に自分の発言として入らなかった（送れていても確かめられていない）`);
      this.log({ type: 'send-unconfirmed', id: entry.id, stream });
    }
    return box.get(entry.id)!;
  }

  triggers(): TriggerEngine {
    this.#triggers ??= new TriggerEngine({
      db: this.ledger().db,
      config: this.#triggerConfig,
      send: (to, line) => this.notifier(to, line),
      log: (rec) => this.log(rec),
      ownerRead: (s) => this.ledger().ownerReadSeq(s),
    });
    return this.#triggers;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#triggers?.stop();
    this.#ledger?.close();
    this.#triggers = undefined;
    this.#ledger = undefined;
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
  #tap?: NetworkTap;
  lastEventAt = '';
  url = '';
  /** 拡張が「取りこぼしたかもしれない」と言った数の合計と、最後の言葉 */
  gaps = 0;
  lastReport = '';

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
    this.#tap = new NetworkTap(cdp, sessionId);
    this.#tap.onCapture = (rule, c) => this.#onCapture(rule, c);
    await this.#syncCaptures();
    if (this.#aff.closeToBackground(this.session)) await this.#armCloseGuard();
    await cdp.send('Page.navigate', { url }, sessionId);
    this.url ||= url;
    this.#aff.log({ type: 'window-opened', session: this.session, url, extensions: this.#aff.extensions.map((e) => e.name) });
  }

  async #syncCaptures(): Promise<void> {
    await this.#tap?.setRules(this.#aff.captureRules());
  }

  #onCapture(rule: CaptureRule, c: Omit<Capture, 'at' | 'session' | 'ext' | 'name'>): void {
    this.lastEventAt = now();
    const full: Capture = { at: this.lastEventAt, session: this.session, ext: rule.ext, name: rule.name, source: 'page', ...c };
    try { appendCapture(this.#aff.home, this.#aff.name, full); }
    catch (e: any) { this.#aff.log({ type: 'capture-write-failed', session: this.session, error: String(e?.message ?? e) }); }
    this.dispatchCapture(full);
  }

  /** 記録済みの通信を、この窓の拡張の onCapture に渡す（ワーカーの通信もここを通る） */
  /** 送る口: 拡張の onSend を、この窓の作業の列の中で動かす（ほかの操作は待つ） */
  runSend(ext: Extension, req: { id: number; stream: string; text: string }): Promise<void> {
    return this.#serial(async () => { await ext.onSend!(req, this.#api(ext)); });
  }

  dispatchCapture(full: Capture): void {
    this.lastEventAt = now();
    const ext = this.#aff.extensions.find((e) => e.name === full.ext);
    // 宣言していないサイトの窓では、拡張を呼ばない（記録は残す）
    if (!ext?.onCapture || !siteMatches(ext.sites, this.url)) return;
    void this.#serial(async () => {
      try { await ext.onCapture!(full, this.#api(ext)); }
      catch (e: any) {
        this.#aff.log({ type: 'extension-error', session: this.session, ext: ext.name, in: 'onCapture', error: String(e?.stack ?? e) });
        await this.#api(ext).notify(`【渡 ${ext.name}】通信の処理で失敗しました: ${e?.message ?? e}`).catch(() => {});
      }
    });
  }

  async #installScript(): Promise<void> {
    if (this.#scriptId) await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.#scriptId }, this.#sid);
    const r = await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: pageScript(this.#injectConfig()), worldName: WORLD }, this.#sid);
    this.#scriptId = r.identifier;
  }

  /** 拡張の出し入れ・名札の変更を、開いている窓に効かせる。 */
  async applyExtensions(): Promise<void> {
    await this.#installScript();
    await this.#syncCaptures();
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

  /**
   * 閉じるボタンを押されても閉じずに、最小化して裏で動かし続ける。
   * ページに「閉じるときに問う」仕掛け（beforeunload）を入れ、その問いに渡が答える:
   * - 直前にページ自身の移動の知らせ（frameRequestedNavigation など）が来ていれば、読み直し・移動なので通す
   * - 来ていなければ、人が閉じようとしているので止めて最小化する
   * Chrome は、人がページを一度も触っていないと問いを出さない。そのため読み込みのたびに渡が名札を 1 回押す。
   * それでも閉じてしまったときは、keepOpen の開き直しが受け止める。渡が自分で閉じるとき（Target.closeTarget）は問いを通らない。
   */
  #guarded = false;
  /** ページ自身が移動を始めてから、その移動が終わるまで（この間の問いは読み直し・移動なので通す） */
  #navPendingSince = 0;
  async #armCloseGuard(): Promise<void> {
    const cdp = this.cdp, sid = this.#sid;
    this.#guarded = true;
    const top = (p: any, s?: string) => s === sid && p.frameId === this.targetId;
    // 移動を始めた: ページ自身が求めた移動（読み直し・リンク・location の書き換え）
    cdp.on('Page.frameRequestedNavigation', (p, s) => { if (top(p, s)) this.#navPendingSince = Date.now(); });
    cdp.on('Page.frameScheduledNavigation', (p, s) => { if (top(p, s)) this.#navPendingSince = Date.now(); });
    // 移動が終わった・取りやめた: もう移動中ではない（読み込み直後に閉じても、移動と取り違えない）
    const done = (p: any, s?: string) => { if (s === sid && (p.frameId === this.targetId || p.frame?.id === this.targetId)) this.#navPendingSince = 0; };
    cdp.on('Page.frameNavigated', (p, s) => done({ frameId: p.frame?.id }, s));
    cdp.on('Page.frameClearedScheduledNavigation', done);
    cdp.on('Page.javascriptDialogOpening', (p, s) => {
      if (s !== sid || p.type !== 'beforeunload') return;
      // 移動中と見なすのは、始まってから 10 秒まで（終わりの知らせを落としても、ずっと「移動中」にしない）
      const isNavigation = this.#navPendingSince > 0 && Date.now() - this.#navPendingSince < 10000;
      void cdp.send('Page.handleJavaScriptDialog', { accept: isNavigation }, sid).catch(() => {});
      if (!isNavigation) {
        this.#aff.log({ type: 'close-to-background', session: this.session });
        void this.minimize();
      }
    });
    // 問いの仕掛けはページの世界に入れる（読み直しても入るように）
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });` }, sid);
  }

  /** 読み込みのたびに、名札の名前の部分を 1 回押して「人が触った」状態にする（閉じる問いを出せるように） */
  async #activateForGuard(): Promise<void> {
    if (!this.#guarded || this.#touching) return;
    try {
      const at = await this.#eval('globalThis.__watariTagNameRect && globalThis.__watariTagNameRect()');
      if (!at) return;
      await this.#mouse(at.x, at.y);
      this.#aff.log({ type: 'close-guard-armed', session: this.session });
    } catch {}
  }

  /** 窓を最小化する（画面に窓が無い headless では何もしない） */
  async minimize(): Promise<boolean> {
    try {
      const { windowId } = await this.cdp.send('Browser.getWindowForTarget', { targetId: this.targetId });
      await this.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      return true;
    } catch { return false; }
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
    if (msg.type === 'ready') {
      this.#aff.log({ type: 'page-ready', session: this.session, url: msg.url, watches: msg.watches });
      void this.#serial(() => this.#activateForGuard());
      return;
    }
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

  /** within のスクロールできる親（無ければページ全体）を探す式 */
  #scrollerExpr(within?: string): string {
    return `(() => {
      let el = ${within ? `document.querySelector(${JSON.stringify(within)})` : 'null'};
      while (el && el !== document.body && el !== document.documentElement) {
        const s = getComputedStyle(el);
        if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight) return el;
        el = el.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    })()`;
  }

  async #scrollUntil(selector: string, opt: ScrollOptions = {}): Promise<ScrollResult> {
    const max = opt.max ?? 60, ratio = opt.stepRatio ?? 0.8, waitMs = opt.waitMs ?? 500, endWaitMs = opt.endWaitMs ?? 1500;
    const sel = JSON.stringify(selector);
    const exists = () => this.#eval(`!!document.querySelector(${sel})`);
    for (let step = 0; step <= max; step++) {
      if (await exists()) return { found: true, steps: step, reachedEnd: false };
      if (step === max) break;
      await this.#waitUntilFree();
      const r = await this.#eval(`(() => { const s = ${this.#scrollerExpr(opt.within)};
        const before = s.scrollTop; s.scrollTop = before + s.clientHeight * ${Number(ratio)};
        return { before, after: s.scrollTop, height: s.scrollHeight }; })()`);
      if (r.after === r.before) {
        // 末尾: 続きの読み込みを待って、伸びたか・出てきたかを見る
        await new Promise((res) => setTimeout(res, endWaitMs));
        if (await exists()) return { found: true, steps: step + 1, reachedEnd: false };
        const h = await this.#eval(`(${this.#scrollerExpr(opt.within)}).scrollHeight`);
        if (h <= r.height) return { found: false, steps: step + 1, reachedEnd: true };
      } else {
        await new Promise((res) => setTimeout(res, waitMs));
      }
    }
    return { found: false, steps: max, reachedEnd: false };
  }

  async #scrollToTop(within?: string): Promise<void> {
    await this.#waitUntilFree();
    await this.#eval(`(() => { const s = ${this.#scrollerExpr(within)}; s.scrollTop = 0; })()`);
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

  /**
   * 一覧を、項目ごとのオブジェクトにして読む。fields の値は
   *   '@属性'        … 項目そのものの属性
   *   'セレクタ'      … 項目の中の要素のテキスト（無ければ null）
   *   'セレクタ@属性' … 項目の中の要素の属性
   *   '.'            … 項目そのもののテキスト
   */
  #collect(itemSelector: string, fields: Record<string, string>): Promise<Array<Record<string, string | null>>> {
    return this.#eval(`(() => {
      const fields = ${JSON.stringify(fields)};
      const get = (item, spec) => {
        const at = spec.lastIndexOf('@');
        const sel = at >= 0 ? spec.slice(0, at).trim() : spec.trim();
        const attr = at >= 0 ? spec.slice(at + 1) : '';
        const el = sel === '' || sel === '.' ? item : item.querySelector(sel);
        if (!el) return null;
        return attr ? el.getAttribute(attr) : (el.textContent || '').trim();
      };
      return [...document.querySelectorAll(${JSON.stringify(itemSelector)})].map((item) => Object.fromEntries(Object.entries(fields).map(([k, s]) => [k, get(item, s)])));
    })()`);
  }

  #logAct(by: string, rec: object): void { this.#aff.log({ session: this.session, by, ...rec }); }

  /** 外（MCP・トレイ）から使う道具。拡張の動きと順番に並ぶ。 */
  readonly act = {
    read: (selector: string) => this.#serial(() => this.#read(selector)),
    collect: (itemSelector: string, fields: Record<string, string>) => this.#serial(() => this.#collect(itemSelector, fields)),
    click: (selector: string) => this.#serial(async () => { await this.#click(selector); this.#logAct('outside', { type: 'click', selector }); }),
    type: (selector: string, text: string) => this.#serial(async () => { await this.#type(selector, text); this.#logAct('outside', { type: 'type', selector, length: text.length }); }),
    press: (key: Key, modifiers = 0) => this.#serial(async () => { await this.#press(key, modifiers); this.#logAct('outside', { type: 'press', key, modifiers }); }),
    info: (maxText = 4000) => this.#serial(async () => {
      const r = await this.#eval(`({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, ${Number(maxText)}) })`);
      return { ...r, touching: this.#touching, label: this.#label, lastEventAt: this.lastEventAt };
    }),
    screenshot: () => this.#serial(async () => (await this.cdp.send('Page.captureScreenshot', { format: 'png' }, this.#sid)).data as string),
    /**
     * 画面の作りを木で返す（拡張のセレクタを探すため）。読むだけ。
     * テキストは textChars 文字で切る（中身を読みたいときは read を使う）。
     */
    scrollUntil: (selector: string, opt: ScrollOptions = {}) => this.#serial(async () => { const r = await this.#scrollUntil(selector, opt); this.#logAct('outside', { type: 'scroll-until', selector, ...r }); return r; }),
    scrollToTop: (within?: string) => this.#serial(() => this.#scrollToTop(within)),
    outline: (selector = 'body', depth = 6, maxNodes = 400, textChars = 12) => this.#serial(() => this.#eval(`(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root) return null;
      let n = 0;
      const keep = ['id', 'class', 'role', 'aria-label', 'data-testid', 'href', 'type', 'name', 'contenteditable'];
      const walk = (el, d) => {
        if (n++ >= ${Number(maxNodes)}) return '…';
        const attrs = {};
        for (const a of el.attributes) if (keep.includes(a.name) || a.name.startsWith('data-')) attrs[a.name] = a.value.slice(0, 80);
        const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join(' ').trim();
        const node = { tag: el.tagName.toLowerCase(), ...attrs };
        if (own) node.text = own.length > ${Number(textChars)} ? own.slice(0, ${Number(textChars)}) + '…(' + own.length + ')' : own;
        const kids = [...el.children].filter((c) => !['SCRIPT', 'STYLE', 'WATARI-TAG'].includes(c.tagName));
        if (kids.length) node.children = d >= ${Number(depth)} ? '(' + kids.length + ' 個)' : kids.map((c) => walk(c, d + 1));
        return node;
      };
      return { nodes: walk(root, 0), truncated: n > ${Number(maxNodes)} };
    })()`)),
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
      collect: (itemSelector, fields) => this.#collect(itemSelector, fields),
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
      scrollUntil: async (selector, opt) => { const r = await this.#scrollUntil(selector, opt); log({ type: 'scroll-until', selector, ...r }); return r; },
      scrollToTop: (within) => this.#scrollToTop(within),
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
      state: this.#aff.stateFor(ext),
      ledger: {
        put: (items, opt = {}) => {
          const r = this.#aff.ledger().put(items);
          this.#aff.triggers().consider(r.added, opt);
          // 送った本文が自分の発言として入ったかを確かめる
          for (const c of this.#aff.outbox().matchLedger([...r.added, ...r.updated])) log({ type: 'send-confirmed', id: c.id, stream: c.stream, by: c.confirmedBy });
          if (r.added.length || r.updated.length) log({ type: 'ledger-put', added: r.added.length, updated: r.updated.length, seenBefore: r.seenBefore, initial: !!opt.initial });
          return r;
        },
        setOwnerRead: (stream, seq, at) => this.#aff.ledger().setOwnerRead(stream, seq, at),
      },
      decode: { mqtt: (b64, opt = {}) => (opt.join ? this.#aff.mqttJoiner.feed(opt.join, b64, opt) : decodeMqtt(b64, opt)) },
      report: (r) => {
        const gaps = Math.max(0, Math.floor(r.gaps ?? 0));
        this.gaps += gaps;
        if (r.note) this.lastReport = r.note;
        log({ type: 'report', gaps, note: r.note });
      },
    };
  }
}
