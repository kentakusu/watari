// 最小の形の入口: 所属 1 つ・窓 1 つ・拡張いくつか。トレイと MCP はまだ無い。
//
//   node src/main.ts --home D:\watari --affiliation kenta --session watari-windows \
//     --url https://example.com/ --extension ./examples/badge-watch/index.ts \
//     --notify '["tsumugi","届ける","{name}"]'
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { Affiliation, type Extension } from './watari.ts';
import { commandNotifier, stdoutNotifier } from './notify.ts';

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    affiliation: { type: 'string' },
    session: { type: 'string' },
    label: { type: 'string' },
    url: { type: 'string' },
    extension: { type: 'string', multiple: true },
    notify: { type: 'string' },
    headless: { type: 'boolean' },
  },
});

const need = (k: keyof typeof values) => {
  const v = values[k];
  if (!v) { console.error(`--${k} が要ります`); process.exit(2); }
  return v as string;
};
const affiliation = need('affiliation');
const session = need('session');
const url = need('url');
const home = values.home ?? process.env.WATARI_HOME ?? resolve(homedir(), '.watari');

const extensions: Extension[] = [];
for (const p of values.extension ?? []) {
  const mod = await import(pathToFileURL(resolve(p)).href);
  extensions.push(mod.default as Extension);
}

const notifier = values.notify ? commandNotifier(JSON.parse(values.notify)) : stdoutNotifier;
const aff = new Affiliation({ name: affiliation, home, notifier, headless: values.headless });
await aff.start();
await aff.openWindow(`${affiliation}/${session}`, url, extensions, values.label ?? session);
console.log(`渡: ${affiliation}/${session} の窓を開きました（記録: ${resolve(home, 'log', affiliation + '.jsonl')}）`);

const stop = async () => { await aff.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
aff.browser!.process.once('exit', () => { console.log('Chrome が閉じたので終わります'); process.exit(0); });
