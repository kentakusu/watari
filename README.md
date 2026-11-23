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

MCP の道具: `open_window`・`window_info`・`read`・`click`・`type_text`・`press_key`・`screenshot`・`set_label`・`list_extensions`・`install_extension`・`remove_extension`・`watari_status`。自分のセッションの窓しか操れません。

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

`notify` は通知のコマンドです。本文を標準入力で渡します。`{session}`（`<所属>/<名前>`）・`{affiliation}`・`{name}` が置き換わります。紡なら `["tsumugi","届ける","{name}"]`。無ければ常駐の標準出力（`log/daemon.out`）に出します。

## 拡張の書き方

[`examples/badge-watch/index.ts`](examples/badge-watch/index.ts) が例です。拡張は `name`・`sites`（触れてよいサイト）・`watch`（見張るセレクタ）・`onChange`（値が変わったときの動き）を持ちます。`onChange` には窓を操る道具（`read`・`click`・`type`・`press`・`notify`）が渡ります。

- 入れるのは MCP の `install_extension`（絶対パス）。同じ所属の開いている窓すべてに、ページを読み直さずに効きます。形が違う拡張は入れずに断ります。
- 見張りはページのスクリプトから見えない別世界で動きます。
- 宣言していないサイトでは、その拡張は呼ばれません。
- 見張っている要素がしばらく見つからないままなら、黙らずに「見つかりません」と通知します。
- 人が窓の名札の「今触ってる」を押している間、`click`・`type`・`press` は待ちます（拡張も MCP も）。

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
