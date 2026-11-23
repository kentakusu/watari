// Claude のセッションごとに立つ MCP サーバー（stdio）。常駐の渡へつなぎ、自分のセッションの窓だけを操る。
// セッション名は --session か、紡の環境変数（TSUMUGI_AFFILIATION / TSUMUGI_SESSION）から取る。
//
//   claude mcp add watari -- node <repo>/src/mcp.ts --home D:\watari
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { client } from './client.ts';
import { resolveHome } from './home.ts';
import { pathForDaemon } from './paths.ts';

const { values } = parseArgs({ options: { home: { type: 'string' }, session: { type: 'string' } }, strict: false });
const home = resolveHome(values.home as string | undefined);
const envSession = process.env.TSUMUGI_AFFILIATION && process.env.TSUMUGI_SESSION ? `${process.env.TSUMUGI_AFFILIATION}/${process.env.TSUMUGI_SESSION}` : undefined;
const session = (values.session as string | undefined) ?? envSession;
const daemon = client(home);

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (e: any) => ({ content: [{ type: 'text' as const, text: `失敗: ${e?.message ?? e}` }], isError: true });

function mySession(): string {
  if (!session) throw new Error('このセッションの名前が分かりません。紡の外で使うなら MCP の引数に --session 所属/名前 を足してください');
  return session;
}
const affiliation = () => mySession().split('/')[0];

/** 道具を 1 つ足す。失敗は isError で返す（黙って空を返さない）。 */
function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (a: z.infer<z.ZodObject<S>>) => Promise<any>) {
  server.registerTool(name, { description, inputSchema: shape }, (async (args: any) => {
    try { return await run(args); } catch (e) { return fail(e); }
  }) as any);
}

const server = new McpServer({ name: 'watari', version: '0.0.0' });

tool('open_window', 'このセッション専用の窓を開く（もう開いていればその窓で URL を開く）。所属の Chrome が止まっていれば起こす。人がその窓でログインすれば、ログインは同じ所属の全セッションで共有される。',
  { url: z.string().describe('開く URL（http/https）'), label: z.string().optional().describe('窓の名札に出す名前。省くとセッション名') },
  async (a) => text(JSON.stringify(await daemon.call('window.open', { session: mySession(), url: a.url, label: a.label }))));

tool('window_info', '窓の URL・題・本文のテキスト（先頭から）・人が「今触ってる」か・最後に画面が動いた時刻を返す。',
  { max_text: z.number().int().min(0).max(100000).optional() },
  async (a) => text(JSON.stringify(await daemon.call('window.info', { session: mySession(), maxText: a.max_text ?? 4000 }), null, 2)));

tool('read', 'セレクタに当たる最初の要素のテキストを返す。見つからなければ null。',
  { selector: z.string() },
  async (a) => text(JSON.stringify(await daemon.call('window.read', { session: mySession(), selector: a.selector }))));

tool('collect', '一覧を項目ごとのオブジェクトにして読む。fields の値は "@属性"（項目の属性）・"セレクタ"（項目の中のテキスト）・"セレクタ@属性"・"."（項目のテキスト）。',
  { selector: z.string().describe('項目のセレクタ'), fields: z.record(z.string(), z.string()) },
  async (a) => text(JSON.stringify(await daemon.call('window.collect', { session: mySession(), selector: a.selector, fields: a.fields }), null, 2)));

tool('click', 'セレクタに当たる要素の真ん中をクリックする（人のクリックと同じ扱い）。人が「今触ってる」の間は待つ。',
  { selector: z.string() },
  async (a) => { await daemon.call('window.click', { session: mySession(), selector: a.selector }); return text('押しました'); });

tool('type_text', 'セレクタに当たる入力欄をクリックしてから文字を入れる。送信は別に click か press_key で。',
  { selector: z.string(), text: z.string() },
  async (a) => { await daemon.call('window.type', { session: mySession(), selector: a.selector, text: a.text }); return text('入れました'); });

tool('press_key', 'キーを 1 回押す。modifiers は Alt=1, Ctrl=2, Meta=4, Shift=8 の和（例: Shift+Enter は 8）。',
  { key: z.enum(['Enter', 'Backspace', 'Tab', 'Escape']), modifiers: z.number().int().min(0).max(15).optional() },
  async (a) => { await daemon.call('window.press', { session: mySession(), key: a.key, modifiers: a.modifiers ?? 0 }); return text('押しました'); });

tool('screenshot', '窓の見えている範囲を画像で返す。',
  {},
  async () => ({ content: [{ type: 'image' as const, data: (await daemon.call('window.screenshot', { session: mySession() })).png, mimeType: 'image/png' }] }));

tool('dom_outline', '窓の画面の作り（タグ・id・class・data- 属性・短く切ったテキスト）を木で返す。拡張のセレクタを探すため。読むだけ。中身のテキストを読むときは read を使う。',
  {
    selector: z.string().optional().describe('根にする要素（既定 body）'),
    depth: z.number().int().min(1).max(30).optional(),
    max_nodes: z.number().int().min(1).max(3000).optional(),
    text_chars: z.number().int().min(0).max(200).optional().describe('テキストを何文字で切るか（既定 12）'),
  },
  async (a) => text(JSON.stringify(await daemon.call('window.outline', { session: mySession(), selector: a.selector, depth: a.depth, maxNodes: a.max_nodes, textChars: a.text_chars }))));

tool('set_label', '窓の名札の名前を変える。',
  { label: z.string().min(1).max(60) },
  async (a) => { await daemon.call('window.label', { session: mySession(), label: a.label }); return text('変えました'); });

tool('list_extensions', 'このセッションの所属に入っている拡張の一覧（誰が・いつ入れたか付き）。',
  {},
  async () => text(JSON.stringify(await daemon.call('extension.list', { affiliation: affiliation() }), null, 2)));

tool('install_extension', '拡張を所属に入れる（同じ名前があれば入れ替える）。同じ所属の開いている窓すべてにその場で効く。path は絶対パス（WSL からは /mnt/<ドライブ>/ の下）。',
  { path: z.string() },
  async (a) => text(JSON.stringify(await daemon.call('extension.install', { affiliation: affiliation(), path: pathForDaemon(a.path), by: mySession() }))));

tool('remove_extension', '拡張を所属から外す。',
  { name: z.string() },
  async (a) => { await daemon.call('extension.remove', { affiliation: affiliation(), name: a.name, by: mySession() }); return text('外しました'); });

tool('search_captures', 'このセッションの所属で、拡張が記録した通信（HTTP の応答・WebSocket のメッセージ）を新しい順に探す。要求の見出し（Cookie 等）は記録していない。matched は当たった総数（limit で切る前）。',
  {
    name: z.string().optional().describe('拡張が付けた記録の名前'),
    ext: z.string().optional(),
    session: z.string().optional().describe('所属/名前。省くと所属のすべての窓'),
    since: z.string().optional().describe('ISO の時刻。これより後だけ'),
    contains: z.string().optional().describe('URL か本文に含む文字'),
    limit: z.number().int().min(1).max(500).optional(),
  },
  async (a) => text(JSON.stringify(await daemon.call('capture.search', { affiliation: affiliation(), ...a }), null, 2)));

tool('recent_log', 'このセッションの所属の記録（見張りの変化・操作・通知・失敗）を新しい順に返す。失敗だけ見るなら types に extension-error / notify-failed / capture-write-failed などを入れる。',
  { types: z.array(z.string()).optional(), limit: z.number().int().min(1).max(500).optional() },
  async (a) => text(JSON.stringify(await daemon.call('log.recent', { affiliation: affiliation(), ...a }), null, 2)));

tool('ledger_unread', '発言の台帳から、AI がまだ読んでいない発言を新しい順に返す（自分の発言と取り消しは除く）。for_me_only で、宛て・返信・全員宛て・自分の 1:1 だけに絞る。読んだ印は付けない（付けるのは ledger_read）。',
  { for_me_only: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() },
  async (a) => text(JSON.stringify(await daemon.call('ledger.unread', { affiliation: affiliation(), forMeOnly: a.for_me_only, limit: a.limit }), null, 2)));

tool('ledger_read', '発言を、前の数件（流れ）と返信先と一緒に読み、AI が読んだ印を付ける。stream と id で 1 件、または trigger_id（知らせの 1 行の id）で、その知らせに入った発言をまとめて読む。contextGap が true なら、前の流れに抜けがある（台帳に無い発言がある）。trigger_id のとき missing は台帳から消えていた発言。',
  {
    stream: z.string().optional(), id: z.string().optional(),
    trigger_id: z.number().int().optional().describe('知らせの番号（trigger id=… の数）'),
    context: z.number().int().min(0).max(50).optional().describe('前の何件まで（既定は 1 件のとき 5・trigger_id のとき 3）'),
  },
  async (a) => text(JSON.stringify(await daemon.call('ledger.read', { affiliation: affiliation(), stream: a.stream, id: a.id, triggerId: a.trigger_id, context: a.context }), null, 2)));

tool('ledger_search', '発言の台帳を全文で探す（本文・部屋の名前・書き手の名前の部分一致・新しい順）。読んだ印は付けない。',
  { q: z.string(), stream: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
  async (a) => text(JSON.stringify(await daemon.call('ledger.search', { affiliation: affiliation(), q: a.q, stream: a.stream, limit: a.limit }), null, 2)));

tool('ledger_fires', '「起こす条件」が最近出した知らせ（id・部屋・当たった条件・発言の組）と、届けの状態（届かなかった数・AI がまだ読んでいない知らせの数と最古の時刻）。',
  { limit: z.number().int().min(1).max(200).optional() },
  async (a) => text(JSON.stringify(await daemon.call('ledger.fires', { affiliation: affiliation(), limit: a.limit }), null, 2)));

tool('send_message', '部屋（台帳の stream）に本文を送る。設定（outbox）で許した部屋だけ。拡張が画面でそのまま送り、台帳に自分の発言として本文が完全一致で入れば confirmed、時間内に入らなければ unconfirmed（送れていても確かめられていない）、送れなければ failed を返す。同じ部屋に同じ本文を少し前に送っていれば断る（unconfirmed のあとに送り直して二重に届くのを防ぐ）。',
  { stream: z.string(), text: z.string(), allow_repeat: z.boolean().optional().describe('同じ本文を少し前に送っていても、本当に送り直す') },
  async (a) => text(JSON.stringify(await daemon.call('outbox.send', { affiliation: affiliation(), stream: a.stream, text: a.text, by: mySession(), allowRepeat: a.allow_repeat }), null, 2)));

tool('outbox_list', '最近の預け（送る口）と、その状態（confirmed / unconfirmed / failed / sending）の数。',
  { limit: z.number().int().min(1).max(200).optional() },
  async (a) => text(JSON.stringify(await daemon.call('outbox.list', { affiliation: affiliation(), limit: a.limit }), null, 2)));

tool('watari_status', '渡の常駐の状態（所属ごとの Chrome・窓・拡張・拡張を読めなかった記録）。窓の stale が true なら、画面も通信も長く動いていない（見えていないかもしれない）。gaps は拡張が「取りこぼしたかもしれない」と報告した数。',
  {},
  async () => text(JSON.stringify(await daemon.call('status'), null, 2)));

await server.connect(new StdioServerTransport());
