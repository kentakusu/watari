// 拡張を入れ直すと、拡張が import する自分のファイルも読み直す（Chrome を使わない）
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtension } from '../src/daemon.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(here, '..', '.test-home-reload-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const write = (ver: string) => {
  mkdirSync(join(dir, 'lib'), { recursive: true });
  // 入り口 → ./parse.mjs → ./lib/deep.mjs と 2 段で import する
  writeFileSync(join(dir, 'lib', 'deep.mjs'), `export const deep = '${ver}';`);
  writeFileSync(join(dir, 'parse.mjs'), `import { deep } from './lib/deep.mjs'; export const parse = () => 'parse-${ver}/' + deep;`);
  writeFileSync(join(dir, 'index.mjs'), `import { parse } from './parse.mjs';
export default { name: 'reload-ext', sites: ['http://example.invalid/*'], watch: [], onChange() {}, version: parse() };`);
};

test('拡張を入れ直すと、import している自分のファイル（2 段先まで）も新しい版になる', async () => {
  write('v1');
  assert.equal((await loadExtension(join(dir, 'index.mjs')) as any).version, 'parse-v1/v1');
  write('v2');
  assert.equal((await loadExtension(join(dir, 'index.mjs')) as any).version, 'parse-v2/v2', '前の版の依存が残っている');
});
