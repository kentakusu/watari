// 外から台帳に入れる小さなコマンド（スクリプト用）。標準入力の JSON を、常駐の ledger.put に渡す。
//   node src/put.ts --affiliation <所属> --source <入れ手> [--initial] [--home <置き場>] < items.json
// 標準入力は、発言の配列（拡張の w.ledger.put と同じ形）か、{ "items": [...] }。0 件（[]）でもよい
// （呼んだこと自体が「見に行った時刻」として残る。「新着なし」と「止まっている」を分けるため）。
// 結果（{ added, updated, unchanged, seenBefore }）を JSON で標準出力に出す。失敗したら標準エラーに理由を出して 1 で終わる。
import { parseArgs } from 'node:util';
import { client } from './client.ts';
import { resolveHome } from './home.ts';

const { values } = parseArgs({
  options: { home: { type: 'string' }, affiliation: { type: 'string' }, source: { type: 'string' }, initial: { type: 'boolean' } },
  strict: true,
});

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  if (!values.affiliation) throw new Error('--affiliation（所属）が要ります');
  if (!values.source) throw new Error('--source（入れ手の名前）が要ります');
  const raw = (await readStdin()).replace(/^﻿/, '');
  let input: unknown;
  try { input = JSON.parse(raw); } catch (e: any) { throw new Error(`標準入力が JSON として読めません: ${e?.message ?? e}`); }
  const items = Array.isArray(input) ? input : (input as any)?.items;
  if (!Array.isArray(items)) throw new Error('標準入力は、発言の配列か { "items": [...] } にしてください');
  const r = await client(resolveHome(values.home)).call('ledger.put', { affiliation: values.affiliation, source: values.source, items, initial: !!values.initial });
  // 返り値は件数と、新しく入った・変わった発言の組（stream と id）だけにする（本文を標準出力に流さない）
  const ids = (xs: any[]) => xs.map((x) => ({ stream: x.stream, id: x.id }));
  process.stdout.write(JSON.stringify({ added: ids(r.added), updated: ids(r.updated), unchanged: r.unchanged, seenBefore: r.seenBefore }) + '\n');
} catch (e: any) {
  process.stderr.write(`渡（put）: ${e?.message ?? e}\n`);
  process.exit(1);
}
