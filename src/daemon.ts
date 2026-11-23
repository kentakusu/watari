// 渡の常駐。所属ごとの Chrome を持ち、127.0.0.1 の口で MCP とトレイからの依頼を受ける。
// 口には合言葉（WATARI_HOME/token）が要る。合言葉なしで通るのは生死の確認（/health）だけ。
import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { searchCaptures, pruneCaptures, listCaptureAffiliations } from './capture.ts';
import { Ledger } from './ledger.ts';
import type { TriggerConfig } from './triggers.ts';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import module from 'node:module';
import { Affiliation, type Extension } from './watari.ts';
import { configuredNotifier } from './notify.ts';
import { ensureToken, restrictHome, perAffiliation, keepOpenList, readConfig, readDaemonInfo, readDisplay, readExtensions, readWindows, writeDaemonInfo, writeDisplay, writeExtensions, writeWindows, type Display, type ExtensionRecord, type WindowRecord } from './home.ts';

export type DaemonOptions = { home: string; port?: number; headless?: boolean; missingGraceMs?: number; notifyOverride?: (session: string, text: string) => Promise<void> };

const now = () => new Date().toISOString();

function splitSession(session: unknown): { affiliation: string; session: string } {
  if (typeof session !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(session)) throw new Error(`セッションは「所属/名前」の形で渡してください: ${String(session)}`);
  return { affiliation: session.split('/')[0], session };
}

const RELOAD_PARAM = 'watari-reload';
let reloadSeq = 0;
let reloadHookInstalled = false;
/**
 * 拡張の入り口だけ URL を変えても、そこから import される './parse.ts' などは URL が同じなので、Node の控えに残った前の版が使われる。
 * 入り口に付けた印を、拡張が import する file: のモジュール（node_modules の外）へ引き継いで、拡張ごと読み直させる。
 */
function installReloadHook() {
  if (reloadHookInstalled) return;
  reloadHookInstalled = true;
  module.registerHooks({
    resolve(specifier, context, next) {
      const r = next(specifier, context);
      const parent = context.parentURL;
      if (!parent || !parent.startsWith('file:') || !r.url.startsWith('file:') || r.url.includes('/node_modules/')) return r;
      const v = new URL(parent).searchParams.get(RELOAD_PARAM);
      if (!v) return r;
      const u = new URL(r.url);
      u.searchParams.set(RELOAD_PARAM, v);
      return { ...r, url: u.href };
    },
  });
}

export async function loadExtension(path: string): Promise<Extension> {
  if (!isAbsolute(path)) throw new Error(`拡張は絶対パスで渡してください: ${path}`);
  if (!existsSync(path)) throw new Error(`拡張のファイルがありません: ${path}`);
  // 入れ直したときに新しい中身を読むよう、毎回別の URL にする（拡張が import する自分のファイルにも同じ印を引き継ぐ）
  installReloadHook();
  const mod = await import(pathToFileURL(path).href + `?${RELOAD_PARAM}=${Date.now()}-${++reloadSeq}`);
  const e = mod.default as Extension;
  const bad = (why: string) => new Error(`拡張の形が違います（${why}）: ${path}`);
  if (!e || typeof e !== 'object') throw bad('default export がありません');
  if (typeof e.name !== 'string' || !/^[\w.-]+$/.test(e.name)) throw bad('name は英数字・_・.・- だけ');
  if (!Array.isArray(e.sites) || !e.sites.length || !e.sites.every((s) => typeof s === 'string')) throw bad('sites が空');
  if (!Array.isArray(e.watch)) throw bad('watch が配列ではない');
  for (const w of e.watch) if (typeof w?.name !== 'string' || typeof w?.selector !== 'string') throw bad('watch の各項に name と selector が要る');
  if (typeof e.onChange !== 'function') throw bad('onChange が関数ではない');
  if (e.notifyTo !== undefined && (typeof e.notifyTo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(e.notifyTo))) throw bad('notifyTo は「所属/名前」');
  if (e.capture !== undefined) {
    if (!Array.isArray(e.capture)) throw bad('capture が配列ではない');
    for (const c of e.capture) {
      if (typeof c?.name !== 'string' || typeof c?.url !== 'string' || !c.url) throw bad('capture の各項に name と url が要る');
      if (c.binary !== undefined && c.binary !== 'drop' && c.binary !== 'base64') throw bad(`capture の binary は 'drop' か 'base64'（${c.binary}）`);
    }
  }
  if (e.onCapture !== undefined && typeof e.onCapture !== 'function') throw bad('onCapture が関数ではない');
  if (e.onSend !== undefined && typeof e.onSend !== 'function') throw bad('onSend が関数ではない');
  if (e.patrol !== undefined) {
    const pt = e.patrol as any;
    if (!pt || typeof pt !== 'object') throw bad('patrol がオブジェクトではない');
    if (typeof pt.rows !== 'string' || !pt.rows) throw bad('patrol.rows（一覧の行のセレクタ）が要る');
    if (typeof pt.key !== 'string' || !pt.key) throw bad('patrol.key（行の中の部屋の鍵）が要る');
    for (const k of ['selected', 'unread', 'home']) if (pt[k] !== undefined && typeof pt[k] !== 'string') throw bad(`patrol.${k} は文字列`);
  }
  return e;
}

export async function startDaemon(opts: DaemonOptions) {
  const home = opts.home;
  const cfg = readConfig(home);
  const staleMs = cfg.staleMs ?? 15 * 60 * 1000;
  const port = opts.port ?? cfg.port;
  // 記録には他人の発言の本文が入るので、置き場をこのユーザーだけに絞ってから合言葉を作る
  const homeAccess = restrictHome(home);
  if (!homeAccess.ok) process.stderr.write(`渡: 置き場の権限を絞れませんでした: ${homeAccess.detail}\n`);
  const token = Buffer.from(ensureToken(home));
  const startedAt = now();
  const affiliations = new Map<string, Affiliation>();
  const loadErrors: Array<{ affiliation: string; path: string; error: string }> = [];

  const notifier = opts.notifyOverride ?? configuredNotifier(cfg.notify);

  async function extensionsFor(affiliation: string): Promise<Extension[]> {
    const out: Extension[] = [];
    for (const r of readExtensions(home).filter((r) => r.affiliation === affiliation)) {
      try { out.push(await loadExtension(r.path)); }
      catch (e: any) { loadErrors.push({ affiliation, path: r.path, error: e.message }); }
    }
    return out;
  }

  async function aff(name: string, start = true): Promise<Affiliation> {
    let a = affiliations.get(name);
    if (a && a.running) return a;
    if (!start) throw new Error(`所属 ${name} の Chrome は動いていません`);
    a = new Affiliation({
      // 見せ方は所属ごと（display.json）。試験などで headless を指定したときはそれに従う
      name, home, notifier, headless: opts.headless ?? (readDisplay(home)[name] === 'hidden' || !!cfg.headless), missingGraceMs: opts.missingGraceMs ?? cfg.missingGraceMs,
      // 毎回読む（設定の triggers を書き換えれば、常駐を起こし直さなくても次の発言から効く）
      triggerConfig: () => triggerConfigOf(name),
      identityConfig: () => { const i = readConfig(home).identity; return i?.[name] ?? i?.['*']; },
      outboxConfig: () => { const o = readConfig(home).outbox; return o?.[name] ?? o?.['*']; },
      // keepOpen の窓は、閉じるボタンを押されても閉じずに最小化して裏で動かす
      closeToBackground: (session) => keepOpenList(readConfig(home).keepOpen).includes(session),
    });
    a.onWindowsChanged = () => saveWindows();
    a.onWindowClosed = (w) => void onLost(a, [w], 'window');
    a.onChromeExited = (lost) => void onLost(a, lost, 'chrome');
    // 窓のある Chrome で、keepOpen の窓の閉じるボタンが押されたら、閉じずに「裏で動かす」に切り替える
    a.onCloseRequested = (session) => {
      if (displayOf(a) !== 'visible' || !keepOpenList(readConfig(home).keepOpen).includes(session)) return false;
      void setDisplay(a.name, 'hidden', `閉じるボタン（${session}）`).catch((e) => a.log({ type: 'display-switch-failed', error: String(e?.message ?? e) }));
      return true;
    };
    await a.start();
    await a.setExtensions(await extensionsFor(name));
    affiliations.set(name, a);
    return a;
  }

  // ---- 窓が閉じられた・Chrome が終わったとき: 黙って止まらない ----
  // 拡張の通知先に 1 行で知らせる。keepOpen に入っている窓は開き直す（短い間に何度も閉じられたらやめて知らせる）
  let stopping = false; // 常駐が自分で止まっている最中は、閉じた窓を知らせも開き直しもしない
  const reopenTimes = new Map<string, number[]>();
  const reopening = new Set<string>();

  async function tell(a: Affiliation, text: string) {
    const targets = a.notifyTargets();
    if (!targets.length) { a.log({ type: 'lost-not-notified', text }); return; }
    for (const t of targets) {
      try { await notifier(t, text); a.log({ type: 'lost-notified', to: t, text }); }
      catch (e: any) { a.log({ type: 'lost-notify-failed', to: t, error: String(e?.message ?? e) }); }
    }
  }

  async function onLost(a: Affiliation, lost: Array<{ session: string; url: string; label: string }>, why: 'window' | 'chrome') {
    if (stopping) return;
    const keep = new Set(keepOpenList(readConfig(home).keepOpen));
    const exts = a.extensions.map((e) => e.name).join('・') || '（拡張なし）';
    if (why === 'chrome') await tell(a, `【渡】所属 ${a.name} の Chrome が終わりました（窓を全部閉じたか、落ちた）。拡張（${exts}）は何も見ていません。`);
    for (const w of lost) {
      if (!keep.has(w.session)) {
        if (why === 'window') await tell(a, `【渡】窓 ${w.session} が閉じられました。この窓では拡張（${exts}）は何も見ていません。開き直すには open_window を、閉じられても開き直すなら config.json の keepOpen に ${w.session} を入れてください。`);
        continue;
      }
      if (reopening.has(w.session)) continue; // 窓が閉じた → Chrome が終わった、と続けて来たときに二重に開かない
      const now = Date.now();
      const times = (reopenTimes.get(w.session) ?? []).filter((t) => now - t < 10 * 60000);
      if (times.length >= 3) {
        await tell(a, `【渡】窓 ${w.session} が短い間に何度も閉じられたので、開き直すのをやめました（10 分で ${times.length} 回）。人が止めたいのでなければ open_window で開き直してください。`);
        continue;
      }
      reopenTimes.set(w.session, [...times, now]);
      reopening.add(w.session);
      try {
        await new Promise((r) => setTimeout(r, 2000)); // Chrome ごと終わるところなら、それを待つ
        if (stopping) return;
        const target = await aff(a.name); // 動いていなければ Chrome を起こし直す
        const reopened = await target.openWindow(w.session, w.url, w.label);
        // 閉じた人の邪魔をしないよう、最小化で開き直す（最小化でも見張りは止まらない）
        const minimized = readConfig(home).keepOpenMinimized === false ? false : await reopened.minimize();
        saveWindows();
        target.log({ type: 'window-reopened', session: w.session, why, minimized });
        await tell(target, `【渡】窓 ${w.session} が${why === 'chrome' ? '（Chrome ごと）' : ''}閉じられたので、${minimized ? '最小化で' : ''}開き直しました（keepOpen）。閉じていた間のものを拡張が読み直すかは、拡張の作り次第です。`);
      } catch (e: any) {
        a.log({ type: 'window-reopen-failed', session: w.session, error: String(e?.message ?? e) });
        await tell(a, `【渡】窓 ${w.session} を開き直せませんでした: ${e?.message ?? e}`);
      } finally {
        reopening.delete(w.session);
      }
    }
  }

  // ---- 見せ方の切り替え（裏で動かす ⇔ 窓を出す） ----
  // 画面の有る無しは Chrome を起こすときにしか決められないので、その所属の Chrome を起こし直す。
  // 開いていた窓は覚えておいて開き直す（ログインはプロファイルに残る）。渡が自分で止めるので、閉じた知らせ・開き直しは動かない。
  const switching = new Set<string>();

  // 今の見せ方は置き場の記録（display.json）が正。Chrome を画面なしで起こすかどうかは、それと試験の指定から決まる
  function displayOf(a: Affiliation): Display {
    return readDisplay(home)[a.name] ?? 'visible';
  }

  async function setDisplay(name: string, d: Display, by: string): Promise<{ name: string; display: Display; changed: boolean; windows: string[] }> {
    if (switching.has(name)) throw new Error(`所属 ${name} は、いま切り替えている最中です`);
    const before = readDisplay(home)[name] ?? 'visible';
    writeDisplay(home, name, d);
    const a = affiliations.get(name);
    if (!a?.running) return { name, display: d, changed: false, windows: [] }; // 次に起こすときから効く
    if (before === d) return { name, display: d, changed: false, windows: [...a.windows.keys()] };
    switching.add(name);
    try {
      const snapshot = [...a.windows.values()].map((w) => ({ session: w.session, url: w.url, label: w.label }));
      const started = Date.now();
      await a.stop();
      affiliations.delete(name);
      const b = await aff(name);
      for (const w of snapshot) await b.openWindow(w.session, w.url, w.label);
      saveWindows();
      b.log({ type: 'display-switched', display: d, by, windows: snapshot.map((w) => w.session), ms: Date.now() - started });
      return { name, display: displayOf(b), changed: true, windows: snapshot.map((w) => w.session) };
    } finally {
      switching.delete(name);
    }
  }

  function triggerConfigOf(name: string): TriggerConfig | undefined {
    const t = readConfig(home).triggers;
    return t?.[name] ?? t?.['*'];
  }

  function affName(v: unknown): string {
    if (typeof v !== 'string' || !/^[^/\\\s.]+$/.test(v)) throw new Error('affiliation が要ります');
    return v;
  }

  // Chrome が動いていない所属の台帳も読めるように、読むためだけに開いたものを持っておく
  const standaloneLedgers = new Map<string, Ledger>();
  function ledgerOf(name: string): Ledger {
    const a = affiliations.get(name);
    if (a?.running) return a.ledger();
    // 読むだけのときに、台帳の無い所属にファイルを作らない
    if (!existsSync(join(home, 'ledger', `${name}.db`))) throw new Error(`所属 ${name} には、まだ台帳がありません（拡張が発言を入れると作られます）`);
    let l = standaloneLedgers.get(name);
    if (!l) { l = new Ledger(home, name); standaloneLedgers.set(name, l); }
    return l;
  }

  function win(session: string) {
    const { affiliation } = splitSession(session);
    const w = affiliations.get(affiliation)?.windows.get(session);
    if (!w) throw new Error(`セッション ${session} の窓は開いていません（open_window で開いてください）`);
    return w;
  }

  /**
   * 開いている窓を書き残す。動いている所属は今の窓で置き換え、動いていない所属（Chrome が落ちた等）の分は残す。
   * 止めている最中・人が所属を止めたときの扱いは呼ぶ側で決める。
   */
  function saveWindows(dropAffiliation?: string) {
    const live = new Set([...affiliations.values()].filter((a) => a.running).map((a) => a.name));
    const kept = readWindows(home).filter((r) => { const af = r.session.split('/')[0]; return !live.has(af) && af !== dropAffiliation; });
    const now: WindowRecord[] = [...affiliations.values()].filter((a) => a.running).flatMap((a) => [...a.windows.values()].map((w) => ({ session: w.session, url: w.url || '', label: w.label })));
    writeWindows(home, [...kept, ...now.filter((r) => r.url)]);
  }

  const restoreErrors: Array<{ session: string; error: string }> = [];
  async function restoreWindows() {
    for (const r of readWindows(home)) {
      try {
        const { affiliation, session } = splitSession(r.session);
        await (await aff(affiliation)).openWindow(session, r.url, r.label);
      } catch (e: any) { restoreErrors.push({ session: r.session, error: e?.message ?? String(e) }); }
    }
  }

  async function applyRegistry(affiliation: string) {
    const a = affiliations.get(affiliation);
    if (a?.running) await a.setExtensions(await extensionsFor(affiliation));
  }

  const methods: Record<string, (p: any) => Promise<any>> = {
    status: async () => ({
      pid: process.pid, startedAt, port, homeAccess,
      loadErrors, restoreErrors,
      affiliations: [...affiliations.values()].map((a) => ({
        name: a.name, running: a.running, startedAt: a.startedAt, display: displayOf(a),
        extensions: a.extensions.map((e) => e.name),
        // 台帳を使っている所属だけ（使っていない所属にファイルを作らない）
        ledger: existsSync(join(home, 'ledger', `${a.name}.db`)) ? {
          aiUnread: a.ledger().countUnread(),
          gaps: a.ledger().gaps(),
          triggers: triggerConfigOf(a.name) ? a.triggers().stats() : '起こす条件が設定されていません',
        } : undefined,
        windows: [...a.windows.values()].map((w) => ({
          session: w.session, label: w.label, url: w.url, touching: w.touching, lastEventAt: w.lastEventAt,
          // 画面も通信も長く動いていない＝見えていないかもしれない（ログイン切れ・止まった画面）。「0 件」と区別するため
          stale: !w.lastEventAt || Date.now() - Date.parse(w.lastEventAt) > staleMs,
          gaps: w.gaps, lastReport: w.lastReport,
          patrol: w.patrolStats(),
        })),
      })),
    }),
    'window.open': async (p) => {
      const { affiliation, session } = splitSession(p.session);
      if (typeof p.url !== 'string' || !/^https?:\/\//.test(p.url)) throw new Error(`url は http(s) で渡してください: ${p.url}`);
      const w = await (await aff(affiliation)).openWindow(session, p.url, p.label ?? session.split('/')[1]);
      if (p.label && p.label !== w.label) await w.setLabel(p.label);
      saveWindows();
      return { session, label: w.label };
    },
    'window.info': async (p) => win(p.session).act.info(p.maxText ?? 4000),
    'window.read': async (p) => ({ text: await win(p.session).act.read(p.selector) }),
    'window.collect': async (p) => {
      if (!p.fields || typeof p.fields !== 'object') throw new Error('fields が要ります（例: {"name": ".title", "id": "@data-id"}）');
      return { items: await win(p.session).act.collect(p.selector, p.fields) };
    },
    'window.click': async (p) => { await win(p.session).act.click(p.selector); return { ok: true }; },
    'window.type': async (p) => { await win(p.session).act.type(p.selector, p.text); return { ok: true }; },
    'window.press': async (p) => { await win(p.session).act.press(p.key, p.modifiers ?? 0); return { ok: true }; },
    'window.screenshot': async (p) => ({ png: await win(p.session).act.screenshot() }),
    'window.scrollUntil': async (p) => {
      if (typeof p.selector !== 'string' || !p.selector) throw new Error('selector が要ります');
      return win(p.session).act.scrollUntil(p.selector, { within: p.within, max: p.max, stepRatio: p.stepRatio, waitMs: p.waitMs, endWaitMs: p.endWaitMs });
    },
    'window.scrollToTop': async (p) => { await win(p.session).act.scrollToTop(p.within); return { ok: true }; },
    'window.outline': async (p) => win(p.session).act.outline(p.selector ?? 'body', p.depth ?? 6, p.maxNodes ?? 400, p.textChars ?? 12),
    'window.touch': async (p) => { win(p.session).setTouching(!!p.on); return { ok: true }; },
    'window.focus': async (p) => { await win(p.session).focus(); return { ok: true }; },
    'window.label': async (p) => { await win(p.session).setLabel(String(p.label)); saveWindows(); return { ok: true }; },
    'window.close': async (p) => { await win(p.session).close(); return { ok: true }; },
    'ledger.unread': async (p) => {
      const name = affName(p.affiliation);
      return { items: ledgerOf(name).unread({ forMeOnly: !!p.forMeOnly, selfStreams: triggerConfigOf(name)?.selfStreams ?? [], limit: p.limit }) };
    },
    'ledger.read': async (p) => {
      const name = affName(p.affiliation);
      if (p.triggerId !== undefined) {
        // 知らせの番号だけで、その知らせに入った発言をまとめて読む（知らせの 1 行には trigger id しか無いため）
        const L = ledgerOf(name);
        let fire: any;
        try { fire = L.db.prepare('SELECT id, at, stream, stream_name, rules, kind, items_json FROM fires WHERE id = ?').get(Number(p.triggerId)); }
        catch { fire = undefined; }
        if (!fire) throw new Error(`その知らせはありません: trigger id=${p.triggerId}`);
        const items = JSON.parse(fire.items_json) as Array<{ stream: string; id: string }>;
        const reads: unknown[] = [];
        const missing: Array<{ stream: string; id: string }> = [];
        for (const it of items) {
          const r = L.read(it.stream, it.id, p.context ?? 3);
          if (r) reads.push(r); else missing.push(it); // 保持の日数で消えたもの
        }
        return { trigger: { id: fire.id, at: fire.at, stream: fire.stream, streamName: fire.stream_name ?? undefined, rules: fire.rules ? fire.rules.split(',') : [], kind: fire.kind }, reads, missing };
      }
      if (typeof p.stream !== 'string' || typeof p.id !== 'string') throw new Error('stream と id か、trigger_id が要ります');
      const r = ledgerOf(name).read(p.stream, p.id, p.context ?? 5);
      if (!r) throw new Error(`台帳にその発言はありません: ${p.stream} / ${p.id}`);
      return r;
    },
    'ledger.list': async (p) => {
      const name = affName(p.affiliation);
      if (typeof p.stream !== 'string' || !p.stream) throw new Error('stream が要ります');
      return ledgerOf(name).list(p.stream, { order: p.order, limit: p.limit, cursor: p.cursor, before: p.before, after: p.after });
    },
    'ledger.search': async (p) => {
      const name = affName(p.affiliation);
      if (typeof p.q !== 'string' || !p.q.trim()) throw new Error('q（探す言葉）が要ります');
      return { items: ledgerOf(name).search(p.q, { stream: p.stream, limit: p.limit }) };
    },
    'ledger.fires': async (p) => {
      const name = affName(p.affiliation);
      const a = affiliations.get(name);
      if (!a?.running) return { items: [], note: 'この所属の Chrome は動いていません（起こす条件も動いていません）' };
      return { items: a.triggers().recentFires(p.limit ?? 20), stats: a.triggers().stats() };
    },
    'outbox.send': async (p) => {
      const name = affName(p.affiliation);
      const a = affiliations.get(name);
      if (!a?.running) throw new Error(`所属 ${name} の Chrome が動いていません（送るには、その所属の窓が開いている必要があります）`);
      if (typeof p.stream !== 'string' || !p.stream || typeof p.text !== 'string') throw new Error('stream と text が要ります');
      return a.send(String(p.by ?? '不明'), p.stream, p.text, { allowRepeat: !!p.allowRepeat });
    },
    'outbox.list': async (p) => {
      const name = affName(p.affiliation);
      const a = affiliations.get(name);
      if (!a?.running) return { items: [], note: 'この所属の Chrome は動いていません' };
      return { items: a.outbox().recent(p.limit ?? 20), counts: a.outbox().counts() };
    },
    'capture.search': async (p) => {
      if (typeof p.affiliation !== 'string' || !p.affiliation) throw new Error('affiliation が要ります');
      return searchCaptures(home, p.affiliation, { name: p.name, ext: p.ext, session: p.session, since: p.since, contains: p.contains, limit: p.limit });
    },
    'log.recent': async (p) => {
      if (typeof p.affiliation !== 'string' || !/^[^/\\\s.]+$/.test(p.affiliation)) throw new Error('affiliation が要ります');
      const file = join(home, 'log', `${p.affiliation}.jsonl`);
      if (!existsSync(file)) return { items: [], note: 'まだ記録がありません' };
      const types: string[] | undefined = Array.isArray(p.types) && p.types.length ? p.types : undefined;
      const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 500);
      // 末尾から読む（大きくなったファイルでも新しいものだけ見ればよい）
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const items: unknown[] = [];
      for (let i = lines.length - 1; i >= 0 && items.length < limit; i--) {
        const rec = JSON.parse(lines[i]);
        if (!types || types.includes(rec.type)) items.push(rec);
      }
      return { items };
    },
    'extension.list': async (p) => readExtensions(home).filter((r) => !p.affiliation || r.affiliation === p.affiliation),
    'extension.install': async (p) => {
      if (typeof p.affiliation !== 'string' || !p.affiliation) throw new Error('affiliation が要ります');
      const ext = await loadExtension(p.path); // 形が違えばここで断る
      const recs = readExtensions(home).filter((r) => !(r.affiliation === p.affiliation && r.name === ext.name));
      const rec: ExtensionRecord = { affiliation: p.affiliation, name: ext.name, path: p.path, installedBy: String(p.by ?? '不明'), installedAt: now() };
      recs.push(rec);
      writeExtensions(home, recs);
      affiliations.get(p.affiliation)?.log({ type: 'extension-installed', ...rec });
      await applyRegistry(p.affiliation);
      return rec;
    },
    'extension.remove': async (p) => {
      const recs = readExtensions(home);
      const kept = recs.filter((r) => !(r.affiliation === p.affiliation && r.name === p.name));
      if (kept.length === recs.length) throw new Error(`拡張 ${p.name} は所属 ${p.affiliation} に入っていません`);
      writeExtensions(home, kept);
      affiliations.get(p.affiliation)?.log({ type: 'extension-removed', name: p.name, by: String(p.by ?? '不明') });
      await applyRegistry(p.affiliation);
      return { ok: true };
    },
    'affiliation.display': async (p) => {
      const name = affName(p.name);
      if (p.display !== 'hidden' && p.display !== 'visible') throw new Error(`display は 'hidden'（裏で動かす）か 'visible'（窓を出す）: ${p.display}`);
      return setDisplay(name, p.display, String(p.by ?? '依頼'));
    },
    'affiliation.stop': async (p) => {
      const a = affiliations.get(p.name);
      if (!a) throw new Error(`所属 ${p.name} は動いていません`);
      await a.stop();
      affiliations.delete(p.name);
      saveWindows(p.name); // 人が止めた所属の窓は開き直さない
      return { ok: true };
    },
    shutdown: async () => { setTimeout(() => void stop(), 10); return { ok: true }; },
  };

  const authorized = (req: IncomingMessage) => {
    const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    return got.length === token.length && timingSafeEqual(got, token);
  };

  const server = createServer(async (req, res) => {
    const reply = (code: number, body: object) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true, pid: process.pid, startedAt });
    if (req.method !== 'POST' || req.url !== '/rpc') return reply(404, { error: 'ありません' });
    if (!authorized(req)) return reply(401, { error: '合言葉が違います' });
    let body = '';
    for await (const c of req) body += c;
    let m: { method: string; params?: any };
    try { m = JSON.parse(body); } catch { return reply(400, { error: 'JSON ではありません' }); }
    const fn = methods[m.method];
    if (!fn) return reply(404, { error: `知らない依頼です: ${m.method}` });
    try { reply(200, { result: await fn(m.params ?? {}) }); }
    catch (e: any) { reply(200, { error: e?.message ?? String(e) }); }
  });

  // 同じ置き場で別の常駐が動いていたら、立たずに知らせる
  const other = readDaemonInfo(home);
  if (other && other.pid !== process.pid) {
    const alive = await fetch(`http://127.0.0.1:${other.port}/health`).then((r) => r.ok).catch(() => false);
    if (alive) throw new Error(`渡はもう動いています（pid ${other.pid}・口 ${other.port}）`);
  }
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolveListen()); });
  let lastPrune = 0;
  const prune = () => {
    lastPrune = Date.now();
    const setting = readConfig(home).captureRetentionDays; // 設定を書き換えたら、常駐を起こし直さなくても次から効く
    for (const a of new Set([...affiliations.keys(), ...listCaptureAffiliations(home)])) {
      try {
        const days = perAffiliation(setting, a); // 所属ごと（書いていない所属は期限なし）
        const gone = pruneCaptures(home, a, days);
        const ldays = perAffiliation(readConfig(home).ledgerRetentionDays, a);
        if (ldays && existsSync(join(home, 'ledger', `${a}.db`))) {
          const n = ledgerOf(a).prune(ldays);
          if (n) affiliations.get(a)?.log({ type: 'ledger-pruned', days: ldays, items: n });
        }
        if (gone.length) affiliations.get(a)?.log({ type: 'captures-pruned', days, files: gone });
      } catch (e: any) { process.stderr.write(`渡: 古い通信の記録を消せませんでした（${a}）: ${e?.message ?? e}\n`); }
    }
  };
  const beat = () => {
    writeDaemonInfo(home, { pid: process.pid, port, startedAt, heartbeatAt: now() });
    saveWindows(); // URL は窓の中で変わるので、ときどき書き残す
    if (Date.now() - lastPrune > 3600_000) prune();
  };
  await restoreWindows();
  beat();
  const heartbeat = setInterval(beat, 30000);

  async function stop() {
    stopping = true;
    clearInterval(heartbeat);
    // 止める直前の窓の URL を書き残す（30 秒ごとの書き残しの間に移った分を落とさない）
    try { saveWindows(); } catch (e: any) { process.stderr.write(`渡: 窓を書き残せませんでした: ${e?.message ?? e}\n`); }
    for (const a of affiliations.values()) await a.stop().catch(() => {});
    for (const l of standaloneLedgers.values()) l.close();
    standaloneLedgers.clear();
    affiliations.clear();
    await new Promise<void>((r) => server.close(() => r()));
    // 名乗りを消す（記録とプロファイルは残す）
    try { unlinkSync(join(home, 'daemon.json')); } catch {}
  }

  // affiliation: 試験と試しのために、動いている所属を外から見る口（口〔RPC〕には出さない）
  return { port, stop, methods, affiliation: (name: string) => affiliations.get(name) };
}

// node src/daemon.ts [--home <dir>] で起動
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { parseArgs } = await import('node:util');
  const { resolveHome } = await import('./home.ts');
  const { values } = parseArgs({ options: { home: { type: 'string' }, headless: { type: 'boolean' } } });
  const d = await startDaemon({ home: resolveHome(values.home), headless: values.headless });
  console.log(`渡が動いています（127.0.0.1:${d.port}）`);
  const bye = async () => { await d.stop(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
