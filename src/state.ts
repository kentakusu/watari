// 拡張の小さな状態（例: 部屋ごとに、どの番号まで知らせたか）。常駐の再起動をまたいで残る。
// 置き場: <WATARI_HOME>/state/<所属>/<拡張>.json。書くたびに丸ごと書き直す（小さな状態のためのもの）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ExtensionState = {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  all(): Record<string, unknown>;
};

/** 状態の大きさの上限。これを超える書き込みは断る（記録や本文の置き場にしないため） */
export const MAX_STATE_BYTES = 1_000_000;

export function stateFile(home: string, affiliation: string, ext: string): string {
  return join(home, 'state', affiliation, `${ext}.json`);
}

export function openState(home: string, affiliation: string, ext: string): ExtensionState {
  const file = stateFile(home, affiliation, ext);
  let data: Record<string, unknown> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const save = (next: Record<string, unknown>) => {
    const text = JSON.stringify(next, null, 1);
    if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error(`拡張 ${ext} の状態が大きすぎます（${Buffer.byteLength(text)} バイト・上限 ${MAX_STATE_BYTES}）`);
    mkdirSync(join(home, 'state', affiliation), { recursive: true });
    // 途中で落ちても半端なファイルを残さないよう、別名に書いてから置き換える
    writeFileSync(file + '.tmp', text);
    renameSync(file + '.tmp', file);
    data = next;
  };
  return {
    get: <T>(key: string) => data[key] as T | undefined,
    set: (key, value) => save({ ...data, [key]: value }),
    delete: (key) => { const { [key]: _, ...rest } = data; save(rest); },
    all: () => structuredClone(data),
  };
}
