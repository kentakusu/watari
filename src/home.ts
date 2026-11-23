// 渡の置き場（WATARI_HOME）にあるもの: 設定・合言葉・常駐の名乗り・拡張の台帳・記録・プロファイル。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type Config = {
  /** 常駐が待ち受ける 127.0.0.1 の口 */
  port: number;
  /**
   * 通知のコマンド（本文は標準入力）。無ければ常駐の標準出力に出すだけ。
   * 所属ごとに変えるときは { "所属": [...], "*": [...] }（例: 所属ごとに別の 紡 が持っている）
   */
  notify?: string[] | Record<string, string[]>;
  missingGraceMs?: number;
  /** 窓の画面も通信もこれだけ動かなければ「古い（stale）」と出す。既定 15 分 */
  staleMs?: number;
  headless?: boolean;
};

export type ExtensionRecord = { affiliation: string; name: string; path: string; installedBy: string; installedAt: string };

export const DEFAULT_PORT = 7960;

export function resolveHome(arg?: string): string {
  return resolve(arg ?? process.env.WATARI_HOME ?? join(homedir(), '.watari'));
}

const readJson = <T>(p: string, fallback: T): T => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : fallback);

export function readConfig(home: string): Config {
  return { port: DEFAULT_PORT, ...readJson<Partial<Config>>(join(home, 'config.json'), {}) };
}

/** 常駐に話しかけるための合言葉。無ければ作る。 */
export function ensureToken(home: string): string {
  mkdirSync(home, { recursive: true });
  const p = join(home, 'token');
  if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  return readFileSync(p, 'utf8').trim();
}

export function readToken(home: string): string {
  const p = join(home, 'token');
  if (!existsSync(p)) throw new Error(`渡の合言葉がありません（${p}）。渡が一度も起動していないようです`);
  return readFileSync(p, 'utf8').trim();
}

export function readExtensions(home: string): ExtensionRecord[] {
  return readJson<ExtensionRecord[]>(join(home, 'extensions.json'), []);
}

export function writeExtensions(home: string, recs: ExtensionRecord[]): void {
  writeFileSync(join(home, 'extensions.json'), JSON.stringify(recs, null, 2) + '\n');
}

export type DaemonInfo = { pid: number; port: number; startedAt: string; heartbeatAt: string };

export function readDaemonInfo(home: string): DaemonInfo | null {
  return readJson<DaemonInfo | null>(join(home, 'daemon.json'), null);
}

export function writeDaemonInfo(home: string, info: DaemonInfo): void {
  writeFileSync(join(home, 'daemon.json'), JSON.stringify(info) + '\n');
}

/** 開いていた窓。常駐が落ちても、再起動しても、次に起きたときに開き直す。 */
export type WindowRecord = { session: string; url: string; label: string };

export function readWindows(home: string): WindowRecord[] {
  return readJson<WindowRecord[]>(join(home, 'windows.json'), []);
}

export function writeWindows(home: string, recs: WindowRecord[]): void {
  writeFileSync(join(home, 'windows.json'), JSON.stringify(recs, null, 2) + '\n');
}
