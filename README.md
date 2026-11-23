# 渡（watari）

人の操作の結果を AI へ渡し、AI の操作を人へ渡し返す、タスクトレイに常駐するアプリです。

**作り始めたところです。** 設計の案は [`docs/設計.md`](docs/設計.md) にあります。

## これは何か

- 専用のプロファイルで Chrome を起こし、人がログインしたまま使う窓を AI（Claude）と共有します。所属ごとに Chrome が 1 つ（ログインは所属で共有）、Claude のセッションごとに窓が 1 つです。
- 窓の画面（DOM）を見張り、変化をきっかけに「拡張」が動きます。拡張は窓を読む・クリックする・文字を入れることができ、結果を AI へ知らせます。
- 拡張は外で書いたコードを入れ込む仕組みです。サイトごとの動きは拡張に置き、本体はどのサイトにも固有の部分を持ちません。

## 形

```
タスクトレイ（electron/main.mjs）── 常駐を起こし、外から生死を見て、落ちたら起こし直す
 └─ 常駐（src/daemon.ts）── 127.0.0.1 の口（合言葉つき）
     ├─ 所属 A の Chrome（専用プロファイル・パイプで操る）── セッションごとの窓
     └─ 拡張（所属ごとの台帳）
Claude のセッション ── MCP（src/mcp.ts）── 常駐の口
```

- Chrome はデバッグのポートを開けず、パイプ（`--remote-debugging-pipe`）でつなぎます。同じ機械のほかのプロセスからは窓を操れません。
- 常駐の口は `127.0.0.1` だけで、合言葉（置き場の `token`）が無いと断ります。合言葉なしで通るのは生死の確認（`GET /health`）だけです。
- 常駐が落ちても、再起動しても、開いていた窓は次に起きたときに開き直します。人が閉じた窓・人が止めた所属の窓は開き直しません。

## 使い方

Node 23.6 以上（TypeScript をそのまま動かします）と Google Chrome が要ります。

```
npm install
npm run tray -- --home=D:\watari     # タスクトレイを起こす（常駐も一緒に起きる）
```

Claude Code に MCP を足します（紡のセッションなら、セッション名は紡の環境変数から取ります）。

```
claude mcp add watari -- node <このリポジトリ>/src/mcp.ts --home D:\watari
# 紡の外なら: ... --session 所属/名前
```

MCP の道具: `open_window`・`window_info`・`read`・`click`・`type_text`・`press_key`・`screenshot`・`set_label`・`list_extensions`・`install_extension`・`remove_extension`・`search_captures`・`recent_log`・`watari_status`。自分のセッションの窓しか操れません。

### 置き場（`--home`・既定は環境変数 `WATARI_HOME`、無ければ `~/.watari`）

C: が小さい機では D: を指してください。

| もの | 中身 |
|---|---|
| `config.json` | `port`（既定 7960）・`notify`（通知のコマンド）・`missingGraceMs`・`headless` |
| `token` | 常駐の口の合言葉（無ければ作る） |
| `extensions.json` | 所属ごとの拡張の台帳（誰が・いつ入れたか） |
| `windows.json` | 開いている窓（開き直すため） |
| `daemon.json` | 動いている常駐の名乗り（pid・口・最後の生存の印） |
| `profiles/<所属>/` | 所属ごとの Chrome のプロファイル（ログインが残る） |
| `log/<所属>.jsonl` | 記録（見張りの変化・操作・通知・失敗） |

`notify` は通知のコマンドです。本文を標準入力で渡します。`{session}`（`<所属>/<名前>`）・`{affiliation}`・`{name}` が置き換わります。紡なら `["tsumugi","届ける","{name}"]`。無ければ常駐の標準出力（`log/daemon.out`）に出します。所属ごとに届け先が違うなら表で書きます（`"*"` はそのほか全部）。

```json
{
  "notify": {
    "kenta": ["tsumugi", "届ける", "{name}"],
    "reatex": ["wsl.exe", "-d", "Reatex", "-e", "bash", "-lc", "exec tsumugi 届ける \"$0\"", "{name}"]
  }
}
```

### WSL のセッションから使う

常駐は Windows で 1 つだけ動かし、WSL の Claude からは WSL の中の Node で MCP を動かします（`networkingMode=Mirrored` なら `127.0.0.1` で常駐に届きます）。

```
claude mcp add watari --scope user -- node /mnt/d/watari/app/src/mcp.ts --home /mnt/d/watari
```

- 拡張は `/mnt/<ドライブ>/` の下に置きます（MCP が Windows の道のりに直して常駐へ渡します）。WSL の中だけにある場所は断ります。
- WSL の 紡 へ通知するときは `wsl.exe -e`（`--` ではなく）を使います。`--` だと既定のシェルを一度通り、`"$0"` などが先に展開されて名前が化けます（実測: `/usr/bin/zsh` になった）。

## 拡張の書き方

[`examples/badge-watch/index.ts`](examples/badge-watch/index.ts) が例です。拡張は `name`・`sites`（触れてよいサイト）・`watch`（見張るセレクタ）・`onChange`（値が変わったときの動き）を持ちます。`onChange` には窓を操る道具（`read`・`click`・`type`・`press`・`notify`）が渡ります。

- 入れるのは MCP の `install_extension`（絶対パス）。同じ所属の開いている窓すべてに、ページを読み直さずに効きます。形が違う拡張は入れずに断ります。
- 見張りはページのスクリプトから見えない別世界で動きます。
- 宣言していないサイトでは、その拡張は呼ばれません。
- 見張っている要素がしばらく見つからないままなら、黙らずに「見つかりません」と通知します。
- 人が窓の名札の「今触ってる」を押している間、`click`・`type`・`press` は待ちます（拡張も MCP も）。
- 読む道具: `read`（最初の 1 つ）・`readAll`（全部）・`attrAll`（属性）・`waitFor`（出てくるまで待つ）。
- `notifyTo`（`所属/名前`）を書くと、通知を窓のセッションとは別のセッションへ送ります。
- `report({ gaps, note })` で「取りこぼしたかもしれない数」を報告できます。状態（`watari_status`）に出ます。

### 通信の記録

拡張が `capture` に URL の glob を書くと、その窓に届いた HTTP の応答と WebSocket のメッセージ（受けた・送ったの向きつき）を、本文ごと `captures/<所属>/<日付>.jsonl` に残し、`onCapture` に渡します。Claude からは MCP の `search_captures` で探せます。

```ts
capture: [{ name: 'messages', url: 'https://example.com/api/messages*' }, { name: 'live', url: 'wss://example.com/*', kinds: ['ws'] }],
async onCapture(c, w) { /* c.body を読み解いて w.notify(...) */ },
```

- **要求の見出し（Cookie・Authorization など）は記録しません。** 残すのは URL・方法・状態・本文だけです。
- 窓の通信を止めたり書き換えたりはしません（止めすぎると、画面が「切れた」とみなして取り直しを増やすことがあります）。
- `capture` を書いた拡張が 1 つも無い所属では、通信を見ません。
- 本文は 1 件 1MB で切ります（切ったら元の長さを `truncatedFrom` に残します）。本文が取れなかったら、黙らず `bodyError` に理由を残します。

### 見えているかを確かめる

- 窓ごとに「最後に画面か通信が動いた時刻」を持ち、`staleMs`（既定 15 分）を超えたら状態に `stale: true` と出します。`0 件` が「見たが無かった」なのか「見えていない（ログイン切れ・止まった画面）」なのかを区別するためです。
- 失敗（拡張の失敗・通知の失敗・記録の書き込みの失敗）は記録に残り、MCP の `recent_log` で読めます。

## 試験

```
npm test       # 本物の Chrome（headless）で、見張り → 拡張 → 操作 → 通知、常駐と MCP、窓の開き直しを通す
npm run check  # 型の検査
```

## 前提

作者が自分で使うためのものです。**堅牢さも商用利用も考えていません。** 他の方が使われるなら「緩い前提」でお願いします。

拡張でどのサイトをどう扱うかは、使う人の責任です。サイトの利用規約（自動での操作・データ収集の扱い）を確かめてから使ってください。

## ライセンス

0BSD（[`LICENSE`](LICENSE)）。
