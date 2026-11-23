// 渡の置き場（WATARI_HOME）にあるもの: 設定・合言葉・常駐の名乗り・拡張の台帳・記録・プロファイル。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { TriggerConfig } from './triggers.ts';
import type { OutboxConfig } from './outbox.ts';
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
  /**
   * 通信の記録を何日残すか（今日を 1 日目と数える）。書かなければ期限なし。
   * 所属ごとに変えるときは { "所属": 日数, "*": 日数 }（書いていない所属は期限なし）
   */
  captureRetentionDays?: number | Record<string, number>;
  /** 発言の台帳を何日残すか（書き方は captureRetentionDays と同じ・既定は期限なし） */
  ledgerRetentionDays?: number | Record<string, number>;
  /** 所属ごとの「起こす条件」（{ "所属": {...}, "*": {...} }）。書いていない所属では起こさない */
  triggers?: Record<string, TriggerConfig>;
  /**
   * 閉じられても（Chrome ごと終わっても）開き直す窓のセッション名（所属/名前）。
   * 短い間に何度も閉じられたら（10 分で 3 回）、人が止めたいとみなして開き直すのをやめて知らせる
   */
  keepOpen?: string[];
  /** keepOpen の窓を開き直すとき最小化するか（既定 true。閉じた人の邪魔をしないため。最小化でも見張りは止まらない） */
  keepOpenMinimized?: boolean;
  /** 所属ごとの送る口（{ "所属": {...}, "*": {...} }）。書いていない所属では送れない */
  outbox?: Record<string, OutboxConfig>;
  headless?: boolean;
};

/** 所属ごとの値を取り出す（数そのものなら全所属、表なら その所属 → "*" の順。無ければ undefined） */
export function perAffiliation<T>(value: T | Record<string, T> | undefined, affiliation: string): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return value as T;
  const table = value as Record<string, T>;
  return affiliation in table ? table[affiliation] : table['*'];
}

export type ExtensionRecord = { affiliation: string; name: string; path: string; installedBy: string; installedAt: string };

export const DEFAULT_PORT = 7960;

export function resolveHome(arg?: string): string {
  return resolve(arg ?? process.env.WATARI_HOME ?? join(homedir(), '.watari'));
}

const readJson = <T>(p: string, fallback: T): T => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : fallback);

export function readConfig(home: string): Config {
  return { port: DEFAULT_PORT, ...readJson<Partial<Config>>(join(home, 'config.json'), {}) };
}

/**
 * 置き場を、いまの OS ユーザー（と SYSTEM・Administrators）だけが触れるように絞る。
 * 記録には他人の発言の本文がそのまま入るため。Windows では親（D:\ など）の権限を継がないようにする。
 * 失敗しても常駐は止めない（理由を返し、状態に出す）。
 */
export function restrictHome(home: string): { ok: boolean; detail: string } {
  mkdirSync(home, { recursive: true });
  if (process.platform !== 'win32') {
    try { chmodSync(home, 0o700); return { ok: true, detail: 'chmod 700' }; }
    catch (e: any) { return { ok: false, detail: `chmod に失敗: ${e?.message ?? e}` }; }
  }
  // 名前でなく SID で指す（Windows の言語で名前が変わるため）
  // コマンドは System32 から呼ぶ（Git Bash などの PATH では同じ名前の別物が先に当たる）
  const sys32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const who = spawnSync(join(sys32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = who.stdout?.trim().split(',').pop()?.replaceAll('"', '');
  if (!sid?.startsWith('S-1-')) return { ok: false, detail: `自分の SID が分かりません: ${who.stderr || who.stdout}` };
  const r = spawnSync(join(sys32, 'icacls.exe'), [home, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return { ok: false, detail: `icacls が ${r.status} で終わりました: ${(r.stdout + r.stderr).trim()}` };
  return { ok: true, detail: `継承を切り、${sid}・SYSTEM・Administrators だけにした` };
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
