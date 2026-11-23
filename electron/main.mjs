// 渡のタスクトレイ。常駐（src/daemon.ts）を起こし、外から生死を見て、落ちたら起こし直す。
// 常駐の中の見張りは常駐と一緒に止まるので、生死はここ（外）で見る。
import { app, Tray, Menu, nativeImage, shell, Notification } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argHome = process.argv.find((a) => a.startsWith('--home='))?.slice('--home='.length);
const home = resolve(argHome ?? process.env.WATARI_HOME ?? join(homedir(), '.watari'));
const readJson = (p, d) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d; } catch { return d; } };
const port = () => readJson(join(home, 'config.json'), {}).port ?? 7960;
const token = () => { try { return readFileSync(join(home, 'token'), 'utf8').trim(); } catch { return ''; } };

// ログオンで起動する設定。名前を決めておく（Electron の既定の名前だと、ほかの Electron アプリとぶつかる）
const loginItem = () => ({ name: 'watari', path: process.execPath, args: [fileURLToPath(import.meta.url), `--home=${home}`] });
const setLoginItem = (on) => app.setLoginItemSettings({ ...loginItem(), openAtLogin: on });
const loginItemOn = () => app.getLoginItemSettings(loginItem()).openAtLogin;
// --login-item=on / off で、メニューを押さずに切り替えられる（入れるとき用）
const loginArg = process.argv.find((a) => a.startsWith('--login-item='))?.slice('--login-item='.length);
if (loginArg === 'on' || loginArg === 'off') setLoginItem(loginArg === 'on');

if (!app.requestSingleInstanceLock()) app.quit();
app.on('window-all-closed', (e) => e.preventDefault());

let tray = null;
let daemon = null;          // 自分が起こした常駐
let status = null;          // 最後に読めた状態
let lastError = '';
let restarts = [];          // 起こし直した時刻（続けて落ちるときは間を空ける）
let quitting = false;

async function rpc(method, params = {}) {
  const res = await fetch(`http://127.0.0.1:${port()}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
    body: JSON.stringify({ method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  return body.result;
}

const healthy = () => fetch(`http://127.0.0.1:${port()}/health`).then((r) => r.ok).catch(() => false);

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: '渡', body }).show();
}

async function startDaemon() {
  if (await healthy()) return; // もう動いている（別に起こしたもの）ならつなぐだけ
  mkdirSync(join(home, 'log'), { recursive: true });
  const out = openSync(join(home, 'log', 'daemon.out'), 'a');
  // Electron の中の Node で常駐を動かす（別に Node を入れなくてよい）
  daemon = spawn(process.execPath, [join(root, 'src', 'daemon.ts'), '--home', home], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  daemon.once('exit', (code) => {
    daemon = null;
    if (quitting) return;
    // 自分から止まった（終了コード 0）なら起こし直さない。メニューから起こせる
    if (code === 0) { lastError = '常駐は止まっています'; void refresh(); return; }
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < 10 * 60 * 1000);
    restarts.push(now);
    const wait = restarts.length > 3 ? 60000 : 2000;
    lastError = `常駐が止まりました（終了コード ${code}）。${wait / 1000} 秒後に起こし直します（10 分で ${restarts.length} 回目）`;
    notify(lastError);
    setTimeout(() => void startDaemon(), wait);
  });
}

async function refresh() {
  try {
    status = await rpc('status');
    if (!daemon || lastError.startsWith('常駐に')) lastError = '';
  } catch (e) {
    status = null;
    lastError = `常駐に届きません: ${e.cause?.code ?? e.message}`;
  }
  updateTray();
}

function icon(alert) {
  // 32x32 の小さな印（茶の四角に、橋のような白い帯）。BGRA で描く
  const n = 32, buf = Buffer.alloc(n * n * 4);
  const [r, g, b] = alert ? [0xc0, 0x39, 0x2b] : [0x8a, 0x4b, 0x2a];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (y * n + x) * 4;
    const corner = Math.min(x, n - 1 - x) < 4 && Math.min(y, n - 1 - y) < 4 && Math.hypot(Math.min(x, n - 1 - x) - 4, Math.min(y, n - 1 - y) - 4) > 4;
    const band = (y >= 14 && y <= 17 && x >= 5 && x <= 26) || ((x >= 8 && x <= 10 || x >= 21 && x <= 23) && y >= 10 && y <= 24);
    const [cr, cg, cb] = band ? [0xf6, 0xf4, 0xef] : [r, g, b];
    buf[i] = cb; buf[i + 1] = cg; buf[i + 2] = cr; buf[i + 3] = corner ? 0 : 0xff;
  }
  return nativeImage.createFromBitmap(buf, { width: n, height: n });
}

function updateTray() {
  if (!tray) return;
  const alert = !status || (status.loadErrors?.length ?? 0) > 0;
  tray.setImage(icon(alert));
  const wins = status?.affiliations?.reduce((n, a) => n + a.windows.length, 0) ?? 0;
  tray.setToolTip(status ? `渡 — 動いています（窓 ${wins}）` : `渡 — ${lastError || '止まっています'}`);
  const menu = buildMenu();
  tray.setContextMenu(menu);
  // 試験用: メニューの中身を書き出す（画面を見なくても確かめられるように）
  if (process.env.WATARI_TRAY_DUMP) {
    const dump = (m) => m.items.map((i) => (i.submenu ? { label: i.label, submenu: dump(i.submenu) } : i.label || '---'));
    writeFileSync(process.env.WATARI_TRAY_DUMP, JSON.stringify({ tooltip: status ? 'ok' : lastError, menu: dump(menu) }, null, 1));
  }
}

const act = (fn) => async () => { try { await fn(); } catch (e) { notify(`失敗しました: ${e.message}`); } await refresh(); };

function buildMenu() {
  const items = [];
  items.push({ label: status ? `渡 — 動いています（口 ${status.port}・pid ${status.pid}）` : `渡 — ${lastError || '止まっています'}`, enabled: false });
  if (status?.loadErrors?.length) items.push({ label: `拡張を読めませんでした: ${status.loadErrors.length} 件（記録を見てください）`, click: () => shell.openPath(join(home, 'log')) });
  items.push({ type: 'separator' });
  for (const a of status?.affiliations ?? []) {
    const sub = [];
    if (!a.windows.length) sub.push({ label: '開いている窓はありません', enabled: false });
    for (const w of a.windows) {
      sub.push({
        label: `${w.label}${w.touching ? '（触ってる）' : ''}`,
        submenu: [
          { label: w.session, enabled: false },
          { label: w.url || '（読み込み中）', enabled: false },
          { label: `最後に画面が動いた: ${w.lastEventAt ? new Date(w.lastEventAt).toLocaleString('ja-JP') : 'まだ'}`, enabled: false },
          { type: 'separator' },
          { label: '前に出す', click: act(() => rpc('window.focus', { session: w.session })) },
          { label: '今触ってる', type: 'checkbox', checked: w.touching, click: act(() => rpc('window.touch', { session: w.session, on: !w.touching })) },
          { label: '窓を閉じる', click: act(() => rpc('window.close', { session: w.session })) },
        ],
      });
    }
    sub.push({ type: 'separator' });
    sub.push({ label: `拡張（${a.extensions.length}）`, enabled: false });
    for (const name of a.extensions) sub.push({ label: `外す: ${name}`, click: act(() => rpc('extension.remove', { affiliation: a.name, name, by: 'トレイ' })) });
    sub.push({ type: 'separator' });
    // 見せ方: 裏で動かす ⇔ 窓を出す（切り替えのあいだ数秒止まる・ログインは残る）
    if (a.display === 'hidden') sub.push({ label: '窓を出す（ログインや画面を見るとき）', click: act(() => rpc('affiliation.display', { name: a.name, display: 'visible', by: 'トレイ' })) });
    else sub.push({ label: '裏で動かす（窓を隠す）', click: act(() => rpc('affiliation.display', { name: a.name, display: 'hidden', by: 'トレイ' })) });
    sub.push({ label: 'この所属の Chrome を止める', click: act(() => rpc('affiliation.stop', { name: a.name })) });
    items.push({ label: `${a.name}${a.running ? '' : '（止まっている）'} — 窓 ${a.windows.length}${a.display === 'hidden' ? '（裏で動いている）' : ''}`, submenu: sub });
  }
  if (status && !status.affiliations.length) items.push({ label: 'まだ Chrome は動いていません（Claude が窓を開くと起きます）', enabled: false });
  if (!status) items.push({ label: '常駐を起こす', click: act(() => startDaemon()) });
  items.push({ type: 'separator' });
  items.push({ label: '記録の場所を開く', click: () => shell.openPath(join(home, 'log')) });
  items.push({ label: '置き場を開く', click: () => shell.openPath(home) });
  items.push({
    label: 'ログオンしたら起動する', type: 'checkbox', checked: loginItemOn(),
    click: (mi) => setLoginItem(mi.checked),
  });
  items.push({ label: '最新に更新', click: () => refresh() });
  items.push({ type: 'separator' });
  items.push({ label: '終了（Chrome も閉じます）', click: () => void quit() });
  return Menu.buildFromTemplate(items);
}

async function quit() {
  quitting = true;
  await rpc('shutdown').catch(() => {});
  // 自分が起こした常駐が抜けるのを少し待つ
  const end = Date.now() + 8000;
  while (daemon && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  app.quit();
}

app.whenReady().then(async () => {
  tray = new Tray(icon(true));
  tray.setToolTip('渡 — 起動中');
  tray.on('click', () => void refresh().then(() => tray.popUpContextMenu()));
  await startDaemon();
  // 常駐が口を開けるまで待つ
  const end = Date.now() + 20000;
  while (!(await healthy()) && Date.now() < end) await new Promise((r) => setTimeout(r, 300));
  await refresh();
  setInterval(() => void refresh(), 15000);
});
