// 通知の口。外のコマンドを呼び、本文を標準入力で渡す。
// 置き換え: {session}＝<所属>/<名前>・{affiliation}＝所属・{name}＝名前
// 例（紡を使うなら）: ["tsumugi", "届ける", "{name}"]
import { spawn } from 'node:child_process';
import type { Notifier } from './watari.ts';

export function commandNotifier(command: string[]): Notifier {
  if (!command.length) throw new Error('通知のコマンドが空です');
  return (session, text) =>
    new Promise((resolve, reject) => {
      const i = session.indexOf('/');
      const affiliation = i < 0 ? '' : session.slice(0, i);
      const name = i < 0 ? session : session.slice(i + 1);
      const args = command.map((a) => a.replaceAll('{session}', session).replaceAll('{affiliation}', affiliation).replaceAll('{name}', name));
      const child = spawn(args[0], args.slice(1), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`通知のコマンドが ${code} で終わりました: ${err.trim()}`))));
      child.stdin.end(text);
    });
}

/** コマンドを決めていないときは、標準出力に出すだけ（黙って捨てない）。 */
export const stdoutNotifier: Notifier = async (session, text) => {
  process.stdout.write(`[通知 → ${session}] ${text}\n`);
};
