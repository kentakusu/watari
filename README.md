# 渡（watari）

人の操作の結果を AI へ渡し、AI の操作を人へ渡し返す、タスクトレイに常駐するアプリです。

**作り始めたところです。** いま動くのは「所属 1 つ・窓 1 つ・拡張いくつか」の最小の形だけで、タスクトレイと MCP はまだありません。設計の案は [`docs/設計.md`](docs/設計.md) にあります。

## 使い方（最小の形）

Node 23.6 以上（TypeScript をそのまま動かします）と Google Chrome が要ります。

```
node src/main.ts --affiliation kenta --session watari-windows \
  --url https://example.com/ --extension ./examples/badge-watch/index.ts \
  --notify '["tsumugi","届ける","{name}"]'
```

- 所属ごとの Chrome のプロファイルと記録は `--home`（既定は環境変数 `WATARI_HOME`、無ければ `~/.watari`）に置きます。C: が小さい機では D: を指してください。
- `--notify` は通知のコマンドです。本文を標準入力で渡します。`{session}`（`<所属>/<名前>`）・`{affiliation}`・`{name}` が置き換わります。省くと標準出力に出します。
- Chrome はデバッグのポートを開けず、パイプ（`--remote-debugging-pipe`）でつなぎます。同じ機械のほかのプロセスからは窓を操れません。

## 拡張の書き方

[`examples/badge-watch/index.ts`](examples/badge-watch/index.ts) が例です。拡張は `name`・`sites`（触れてよいサイト）・`watch`（見張るセレクタ）・`onChange`（値が変わったときの動き）を持ちます。`onChange` には窓を操る道具（`read`・`click`・`type`・`press`・`notify`）が渡ります。

- 見張りはページのスクリプトから見えない別世界で動きます。
- 宣言していないサイトでは、その拡張は呼ばれません。
- 見張っている要素が見つからなくなったら、黙らずに「見つかりません」と通知します。
- 人が窓の名札の「今触ってる」を押している間、`click`・`type`・`press` は待ちます。

## 試験

```
npm install
npm test     # 本物の Chrome（headless）で 見張り → 拡張 → 操作 → 通知 を通す
npm run check  # 型の検査
```

## これは何か

- 専用のプロファイルで Chrome を起こし、人がログインしたまま使う窓を AI（Claude）と共有します。
- 窓の画面（DOM）を見張り、変化をきっかけに「拡張」が動きます。拡張は窓を読む・クリックする・文字を入れることができ、結果を AI へ知らせます。
- 拡張は外で書いたコードを入れ込む仕組みです。サイトごとの動きは拡張に置き、本体はどのサイトにも固有の部分を持ちません。

## 前提

作者が自分で使うためのものです。**堅牢さも商用利用も考えていません。** 他の方が使われるなら「緩い前提」でお願いします。

拡張でどのサイトをどう扱うかは、使う人の責任です。サイトの利用規約（自動での操作・データ収集の扱い）を確かめてから使ってください。

## ライセンス

0BSD（[`LICENSE`](LICENSE)）。
