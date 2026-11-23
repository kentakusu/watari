// 例: 未読のバッジに数字が入ったら、最新の発言を読み、返事を入れて送り、既読にして、Claude へ知らせる。
// 試験用のページ（test/fixtures/inbox.html）に合わせてある。実際のサイトに使うときは、セレクタと sites を書き換える。
import type { Extension } from '../../src/watari.ts';

const ext: Extension = {
  name: 'badge-watch',
  sites: ['http://127.0.0.1:*/*'],
  watch: [{ name: '未読', selector: '#badge' }],
  async onChange(e, w) {
    const n = Number(e.value);
    if (!(n > 0)) return; // 0 に戻ったときは何もしない
    const latest = await w.read('#latest');
    await w.type('#msg', '受け取りました');
    await w.click('#send');
    await w.click('#mark-read');
    await w.notify(`未読 ${n} 件。最新: ${latest}`);
  },
};
export default ext;
