// 所属ごとの Chrome を、専用プロファイルとパイプで起こす。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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

export type Browser = { cdp: Cdp; process: ChildProcess; close: () => Promise<void> };

export async function launchChrome(opts: LaunchOptions): Promise<Browser> {
  mkdirSync(opts.profileDir, { recursive: true });
  const args = [
    `--user-data-dir=${opts.profileDir}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    // 背景・最小化の窓でも見張りが遅れないように（効き目は要実測）
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
  if (opts.headless) args.push('--headless=new');
  args.push('about:blank');
  const child = spawn(opts.chromePath ?? findChrome(), args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const cdp = new Cdp(child.stdio[3] as any, child.stdio[4] as any);
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  // 起きたことを 1 回の応答で確かめる（応答が無ければ起きていない）
  await Promise.race([
    cdp.send('Browser.getVersion'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Chrome が 15 秒 応答しません（同じプロファイルを別の Chrome が開いていないか見てください）')), 15000)),
  ]);
  return {
    cdp,
    process: child,
    close: async () => {
      if (!cdp.closed) await cdp.send('Browser.close').catch(() => {});
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode === null) child.kill();
    },
  };
}
