// 所属ごとの Chrome を、専用プロファイルとパイプで起こす。
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Cdp } from './cdp.ts';

export function findChrome(): string {
  const env = process.env.WATARI_CHROME;
  if (env) return env;
  const candidates =
    process.platform === 'win32'
      ? [
          join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
          join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
          join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`Chrome が見つかりません。WATARI_CHROME に実行ファイルのパスを入れてください（探した場所: ${candidates.join(' / ')}）`);
  return found;
}

export type LaunchOptions = { profileDir: string; headless?: boolean; chromePath?: string };

export type Browser = { cdp: Cdp; process: ChildProcess; leftovers: { waitedFor: number[] }; close: () => Promise<void> };

type ChromeProc = { pid: number; commandLine: string };

/** そのプロファイルを開いている Chrome（の本体と子）を探す。 */
export function chromesOnProfile(profileDir: string): ChromeProc[] {
  // Windows では同じ場所が / でも \ でも書けるので、両方を同じ形にそろえてから比べる
  const norm = (x: string) => (process.platform === 'win32' ? x.replaceAll('/', '\\').toLowerCase() : x);
  const want = norm(`--user-data-dir=${resolve(profileDir)}`);
  let rows: ChromeProc[] = [];
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true });
    const parsed = r.stdout.trim() ? JSON.parse(r.stdout) : [];
    rows = (Array.isArray(parsed) ? parsed : [parsed]).map((x: any) => ({ pid: x.ProcessId, commandLine: String(x.CommandLine ?? '') }));
  } else {
    const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    rows = r.stdout.split('\n').filter(Boolean).map((l) => { const m = l.trim().match(/^(\d+)\s+(.*)$/); return { pid: Number(m?.[1]), commandLine: m?.[2] ?? '' }; });
  }
  return rows.filter((x) => norm(x.commandLine.replaceAll('"', '')).includes(want));
}

/** Chrome の本体（子のプロセスでないもの）か。 */
export const isBrowserProcess = (p: ChromeProc) => !p.commandLine.includes('--type=');

/**
 * 前の渡のパイプの Chrome が、まだ終わりきっていなければ待つ（殺さない）。
 * パイプが切れた Chrome は自分から終わる（実測: 持ち主を強制終了すると 2 秒以内に 0 本）。
 * 終わる前に起こすと、残っている Chrome に手渡しされて新しい方がすぐ終わるので、その間だけ待つ。
 */
async function waitForPipeLeftovers(profileDir: string, ms = 5000): Promise<number[]> {
  const pipeOnes = () => chromesOnProfile(profileDir).filter((p) => isBrowserProcess(p) && p.commandLine.includes('--remote-debugging-pipe')).map((p) => p.pid);
  const first = pipeOnes();
  const end = Date.now() + ms;
  while (pipeOnes().length && Date.now() < end) await new Promise((r) => setTimeout(r, 300));
  return first;
}

export async function launchChrome(opts: LaunchOptions): Promise<Browser> {
  mkdirSync(opts.profileDir, { recursive: true });
  const leftovers = { waitedFor: await waitForPipeLeftovers(opts.profileDir) };
  const args = [
    `--user-data-dir=${resolve(opts.profileDir)}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    // 背景・最小化の窓でも見張りが遅れないように（効き目は要実測）
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // 窓を全部閉じたら終わる（残ると、つながりの無い Chrome がプロファイルをつかんだままになる）
    '--disable-background-mode',
  ];
  // 最初の空の窓（about:blank）を出さない。窓はセッションごとに渡が開く
  if (opts.headless) args.push('--headless=new', 'about:blank');
  else args.push('--no-startup-window');
  const child = spawn(opts.chromePath ?? findChrome(), args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const cdp = new Cdp(child.stdio[3] as any, child.stdio[4] as any);
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  // つながりが切れたのに Chrome が残ったら、少し待って閉じる（自分の子なので、もう誰も操れない）
  (child.stdio[4] as any).once('close', () => {
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 5000);
  });
  // 起きたことを 1 回の応答で確かめる（応答が無ければ起きていない）
  const busy = () => {
    const others = chromesOnProfile(opts.profileDir).filter((p) => isBrowserProcess(p) && p.pid !== child.pid).map((p) => p.pid);
    return others.length ? `同じプロファイル（${opts.profileDir}）を別の Chrome が開いています（pid ${others.join(', ')}）。その Chrome を閉じてから渡を起こしてください` : '';
  };
  try {
    await Promise.race([
      cdp.send('Browser.getVersion'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Chrome が 15 秒 応答しません')), 15000)),
    ]);
  } catch (e: any) {
    if (child.exitCode === null) child.kill();
    throw new Error(busy() || `Chrome を起こせませんでした: ${e.message}`);
  }
  return {
    cdp,
    process: child,
    leftovers,
    close: async () => {
      if (!cdp.closed) await cdp.send('Browser.close').catch(() => {});
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode === null) child.kill();
    },
  };
}
