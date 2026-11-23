// 渡の常駐。所属ごとの Chrome を持ち、127.0.0.1 の口で MCP とトレイからの依頼を受ける。
// 口には合言葉（WATARI_HOME/token）が要る。合言葉なしで通るのは生死の確認（/health）だけ。
import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { searchCaptures, pruneCaptures, listCaptureAffiliations } from './capture.ts';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Affiliation, type Extension } from './watari.ts';
import { configuredNotifier } from './notify.ts';
import { ensureToken, restrictHome, readConfig, readDaemonInfo, readExtensions, readWindows, writeDaemonInfo, writeExtensions, writeWindows, type ExtensionRecord, type WindowRecord } from './home.ts';

export type DaemonOptions = { home: string; port?: number; headless?: boolean; missingGraceMs?: number; notifyOverride?: (session: string, text: string) => Promise<void> };

const now = () => new Date().toISOString();

function splitSession(session: unknown): { affiliation: string; session: string } {
  if (typeof session !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(session)) throw new Error(`セッションは「所属/名前」の形で渡してください: ${String(session)}`);
  return { affiliation: session.split('/')[0], session };
}

export async function loadExtension(path: string): Promise<Extension> {
  if (!isAbsolute(path)) throw new Error(`拡張は絶対パスで渡してください: ${path}`);
  if (!existsSync(path)) throw new Error(`拡張のファイルがありません: ${path}`);
  // 入れ直したときに新しい中身を読むよう、毎回別の URL にする
  const mod = await import(pathToFileURL(path).href + `?v=${Date.now()}`);
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
    for (const c of e.capture) if (typeof c?.name !== 'string' || typeof c?.url !== 'string' || !c.url) throw bad('capture の各項に name と url が要る');
  }
  if (e.onCapture !== undefined && typeof e.onCapture !== 'function') throw bad('onCapture が関数ではない');
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
    a = new Affiliation({ name, home, notifier, headless: opts.headless ?? cfg.headless, missingGraceMs: opts.missingGraceMs ?? cfg.missingGraceMs });
    a.onWindowsChanged = () => saveWindows();
    await a.start();
    await a.setExtensions(await extensionsFor(name));
    affiliations.set(name, a);
    return a;
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
        name: a.name, running: a.running, startedAt: a.startedAt,
        extensions: a.extensions.map((e) => e.name),
        windows: [...a.windows.values()].map((w) => ({
          session: w.session, label: w.label, url: w.url, touching: w.touching, lastEventAt: w.lastEventAt,
          // 画面も通信も長く動いていない＝見えていないかもしれない（ログイン切れ・止まった画面）。「0 件」と区別するため
          stale: !w.lastEventAt || Date.now() - Date.parse(w.lastEventAt) > staleMs,
          gaps: w.gaps, lastReport: w.lastReport,
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
    'window.outline': async (p) => win(p.session).act.outline(p.selector ?? 'body', p.depth ?? 6, p.maxNodes ?? 400, p.textChars ?? 12),
    'window.touch': async (p) => { win(p.session).setTouching(!!p.on); return { ok: true }; },
    'window.focus': async (p) => { await win(p.session).focus(); return { ok: true }; },
    'window.label': async (p) => { await win(p.session).setLabel(String(p.label)); saveWindows(); return { ok: true }; },
    'window.close': async (p) => { await win(p.session).close(); return { ok: true }; },
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
    const days = readConfig(home).captureRetentionDays; // 設定を書き換えたら、常駐を起こし直さなくても次から効く
    for (const a of new Set([...affiliations.keys(), ...listCaptureAffiliations(home)])) {
      try {
        const gone = pruneCaptures(home, a, days);
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
    clearInterval(heartbeat);
    for (const a of affiliations.values()) await a.stop().catch(() => {});
    affiliations.clear();
    await new Promise<void>((r) => server.close(() => r()));
    // 名乗りを消す（記録とプロファイルは残す）
    try { unlinkSync(join(home, 'daemon.json')); } catch {}
  }

  return { port, stop, methods };
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
