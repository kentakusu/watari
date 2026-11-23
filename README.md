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
- **見せ方は所属ごとに 2 つ**です。`visible`（窓のある Chrome。最初のログインや、人が画面を見るとき）と `hidden`（画面の無い Chrome で裏で動かす。窓もタスクバーも出ない）。トレイの所属のメニュー（「窓を出す」「裏で動かす」）か、MCP の `set_display` で切り替えます。切り替えのたびにその所属の Chrome を起こし直します（数秒〜10 秒ほど見張りが止まる・開いていた窓と拡張は戻る・ログインはプロファイルに残る）。見せ方は `display.json` に残り、常駐を起こし直しても続きます。書いていない所属は `visible` から始まります。
- 画面の無い Chrome でも、サイトにはふつうの Chrome の名前（UA）で名乗ります。
- 拡張の入った窓が閉じられたら（Chrome ごと終わったときも）、黙らずにその所属の拡張の通知先（`notifyTo`）へ 1 行で知らせます。
- `config.json` の `keepOpen` に書いた窓（`所属/名前`）は、**閉じるボタンを押されても閉じずに、その所属を `hidden`（裏で動かす）に切り替えます**（すでに `hidden` なら最小化）。ページの「閉じるときの問い」（beforeunload）に渡が「離れない」と答える仕組みです。サイト自身の読み直しやリンクでの移動は止めません（ページ自身が移動を始めてから終わるまでの問いは通す）。Chrome は人がページを触っていないと問いを出さないので、読み込みのたびに渡が名札を 1 回押します。
- それでも閉じたとき（Chrome ごと終わったときを含む）は、2 秒後に**最小化で**開き直し、知らせます（見張りは最小化でも止まらない。最小化しないなら `keepOpenMinimized: false`）。10 分に 3 回を超えて閉じられたら、人が止めたいとみなして開き直すのをやめ、知らせます。本当に止めるときは、所属を止めるか拡張を外します。

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

MCP の道具: `open_window`・`window_info`・`read`・`click`・`type_text`・`press_key`・`screenshot`・`set_label`・`list_extensions`・`install_extension`・`remove_extension`・`search_captures`・`recent_log`・`ledger_unread`・`ledger_read`・`ledger_search`・`ledger_fires`・`send_message`・`outbox_list`・`collect`・`dom_outline`・`watari_status`。自分のセッションの窓しか操れません。

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
    "team-b": ["tsumugi", "届ける", "{name}"],
    "team-a": ["wsl.exe", "-d", "Ubuntu", "-e", "bash", "-lc", "exec tsumugi 届ける \"$0\"", "{name}"]
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
- 見えている分しか描かない一覧は `scrollUntil(探す要素, { within: 一覧の中の要素 })` で、探す要素が出るまで下へたどれます（末尾では続きの読み込みを待つ・人の「今触ってる」の間は待つ）。`scrollToTop(within)` で先頭に戻せます。MCP は `scroll_until`。
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

- 窓そのものの通信に加え、**共有ワーカー・サービスワーカーの通信**も同じ規則で取ります（記録の `source` が `page` / `shared_worker` / `service_worker`、ワーカーなら `workerUrl`）。ワーカーは起きる前に止めてもらい、記録を有効にしてから動かします（あとからつなぐと最初の接続を取り逃がすため）。ワーカーは窓をまたいで共有されるので、その拡張の `sites` に当たる窓の `onCapture` に渡します。
- バイナリ（WebSocket のバイナリのフレーム・HTTP のバイナリの応答）は、既定では長さだけ（`[binary N base64]`）を残します。規則に `binary: 'base64'` と書くと、中身を base64 のまま `body` に残します（記録の `encoding` が `'base64'`）。1MB を超えるものは、途中で切ると読めなくなるので残しません。
- WebSocket の上の MQTT は `w.decode.mqtt(c.body, { join: c.connection })` で開けます。1 つのフレームの中の複数のパケットを順に開き、PUBLISH は `topic` と中身（`payload`（base64）・読めれば `payloadText`・JSON なら `payloadJson`）を返します。版 5 は `version: 5`。
  - `join` に記録の `connection`（接続の id）を渡すと、前のフレームで切れた残りとつなぎ直します（渡さなければ、切れたものは `truncated: true`）。
  - どんな入力でも投げません。中の長さが合わない（フレームがパケットの途中から始まっている等）ときは `malformed` に理由を入れて、そこで止めます。
- 残す日数は `config.json` の `captureRetentionDays`（今日を 1 日目と数える）。**書かなければ期限なし**です。数を書くと全部の所属に、`{ "team-a": 30, "*": 7 }` のように書くと所属ごとに効きます（書いていない所属は `"*"`、それも無ければ期限なし）。書き換えると、常駐を起こし直さなくても 1 時間以内に効きます。

### 拡張の状態

`w.state.get(key)` / `w.state.set(key, value)` / `w.state.delete(key)` で、小さな状態（例: どの番号まで知らせたか）を残せます。所属と拡張ごとに `state/<所属>/<拡張>.json` に置かれ、常駐の再起動をまたいで残ります。1MB を超える書き込みは断ります（本文や記録の置き場にしないため）。

### 発言の台帳と、起こす条件

チャット・メール・通知のような「発言」を、拡張が読み解いて `w.ledger.put([...])` で渡すと、渡が所属ごとの台帳（`ledger/<所属>.db`・SQLite）に残します。

```ts
w.ledger.put([{
  stream: 'room-123', id: 'msg-456', seq: 456,          // 部屋・発言の id・通し番号（あれば抜けを数える）
  streamKind: 'group', streamName: '営業の部屋',          // direct / group / self / bot / other
  author: 'u-1', authorKind: 'human', authorName: '田中',
  at: '2026-11-23T08:00:00Z', text: '本文',
  to: ['u-me'], toAll: false, toMe: true,                // 誰宛てか（「自分宛て」は拡張が判断して入れる）
  replyTo: { id: 'msg-400', author: 'u-me' }, replyToMe: true,
  mine: false, recalled: false, meta: { /* 拡張が残したいもの */ },
}]);
w.ledger.setOwnerRead('room-123', 455);                  // 持ち主がどこまで読んだか
```

- **書き手の見分けは設定で**します。拡張は書き手の id・名前・人か Bot か（`authorKind`）を素直に入れるだけにし、`config.json` の `identity`（所属ごと）で直します:
  - `ownAuthors`（id）に当たる書き手は、持ち主の側（`mine: true`）
  - 自分の 1:1（起こす条件の `selfStreams`）に出てきた Bot は、持ち主の側として覚える（台帳に残る。`learnOwnBotsFromSelfStreams: false` で切れる）
  - `proxyAuthorNames`（名前の一部）に当たる Bot は、人と同じに扱う（ほかの人の代理の Bot のため。持ち主の側の Bot には当たらない）
- 同じ発言（`stream` と `id` の組）は 1 回だけ残します。中身が変わったら（取り消し・編集）更新として返します。
- 消したあとに同じ発言を取り直しても、新しいものとは扱いません。
- `seq` があれば、部屋ごとに番号の抜けを数えて状態に出します。
- 全文検索は日本語の部分一致です（3 文字以上は trigram、2 文字以下も探せます）。
- 最初の一括取り込みは `put(items, { initial: true })` にします（起こしません）。

**起こす条件**は `config.json` の `triggers` に、所属ごとに書きます。当たった発言があれば、本文を含まない 1 行（`trigger id=… rules=… kind=… count=… stream=…`）を `notifyTo` へ知らせます。本文は MCP の `ledger_read` で引きます。

```json
{
  "triggers": {
    "所属": {
      "notifyTo": "所属/統括のセッション名",
      "maxAgeMinutes": 60, "quietSeconds": 20, "maxWaitSeconds": 120, "hourlyLimit": 30,
      "selfStreams": ["持ち主が Claude に話しかける部屋"],
      "namedStreams": ["持ち主が先に読んでいても起こす部屋"],
      "rules": [
        { "name": "toMe", "toMe": true },
        { "name": "reply", "replyToMe": true },
        { "name": "direct", "streamKinds": ["direct"] },
        { "name": "urgent", "keywords": ["至急", "緊急"] }
      ]
    }
  }
}
```

- 起こさないもの: 有効にした時刻（`enabledAt`。書かなければ常駐が起きた時刻）より前・`maxAgeMinutes` より古い・最初の一括取り込み・取り消し・自分の発言（`selfStreams` は別）・持ち主が先に読んだ発言（`namedStreams` と `selfStreams` は別）・所属全体の `authorKinds`（例: `["human"]`）に入っていない書き手の種類（`selfStreams` と `namedStreams` にも効く。書き手の種類が分からない発言は通す）。
- 条件には、ほかに `authorKinds`（書き手の種類）と `spokeRecentlyHours`（持ち主がその部屋でこの時間内に発言していれば当たる＝会話の続き）を書けます。
- `selfStreams` は静けさを待たずに出します（`selfQuietSeconds`・既定 0）。
- `linePrefix` / `lineSuffix` で、知らせの 1 行の頭と尾に固定の文を付けられます（どこから来た知らせか・受け取った人が何をする行かを決めるため）。改行は空白にして 1 行を保ちます。発言の本文は入りません。
- 1 つの条件の中は「全部に当たる」、条件どうしは「どれかに当たる」です。配列の中は「どれか 1 つ」です。書き手（`authors`）は id か名前の部分一致です。
- 同じ部屋の続けての発言は、`quietSeconds` 静かになるまで（最長 `maxWaitSeconds`）待って 1 回にまとめます。
- 1 時間に `hourlyLimit` を超えた分は「まとめ」1 件に畳みます（`selfStreams` は上限の外）。
- 設定を書き換えると、常駐を起こし直さなくても次の発言から効きます。台帳を残す日数は `ledgerRetentionDays`（書き方は `captureRetentionDays` と同じ・既定は期限なし）。

MCP: `ledger_unread`（AI がまだ読んでいない発言・`for_me_only` で宛てだけ）・`ledger_read`（前の流れと返信先と一緒に読み、読んだ印を付ける。流れに抜けがあれば `contextGap`。`trigger_id` を渡すと、その知らせに入った発言をまとめて読む）・`ledger_list`（ある部屋の発言を時刻の順にページでめくる。写しや見返し用で、読んだ印は付けない）・`ledger_search`（全文）・`ledger_fires`（最近の知らせと、届かなかった数・AI がまだ読んでいない知らせの数と最古の時刻）。

### 送る口（関所つき）

Claude が MCP の `send_message`（部屋と本文）で預けると、拡張の `onSend` が画面でその本文をそのまま送り、本体が台帳で確かめます。

```ts
async onSend(req, w) {            // req = { id, stream, text }
  // req.text を変えずに、画面で req.stream の部屋に送る。送れなければ投げる
  // 送ったあと、画面や通信に出た自分の発言を w.ledger.put で台帳に入れる（mine: true）
},
```

```json
{ "outbox": { "所属": { "allowedStreams": ["持ち主と Claude の 1:1"], "allowedStreamKinds": ["direct"], "confirmSeconds": 60, "repeatGuardMinutes": 10 } } }
```

- 設定（`outbox`）で許した部屋（`allowedStreams`）か、部屋の種類（`allowedStreamKinds`・台帳の `streamKind`）にしか送りません。設定が無ければ送る口は閉じています。
- 1 つの預けは 1 回しか送りません。同じ部屋に同じ本文を `repeatGuardMinutes` 以内に預かっていれば断ります（「確かめられない」のあとに送り直して二重に届くのを防ぐ。本当に送り直すなら `allow_repeat`）。
- 結果は 3 つです: `confirmed`（台帳に自分の発言として本文が完全一致で入った）／`unconfirmed`（`confirmSeconds` 待っても入らなかった＝送れていても確かめられていない。あとで入れば `confirmed` に変わる）／`failed`（`onSend` が投げた）。
- `onSend` が動いている間は、同じ窓の拡張のほかの操作は待ちます（部屋を切り替えて書きかけが消えないように）。人が「今触ってる」を押している間は、`onSend` の中の `click`・`type` も待ちます。
- 預けと結果は台帳（`ledger/<所属>.db`）と記録に残ります。MCP の `outbox_list` で最近の預けと状態の数が見られます。

### 見えているかを確かめる

- 窓ごとに「最後に画面か通信が動いた時刻」を持ち、`staleMs`（既定 15 分）を超えたら状態に `stale: true` と出します。`0 件` が「見たが無かった」なのか「見えていない（ログイン切れ・止まった画面）」なのかを区別するためです。
- 失敗（拡張の失敗・通知の失敗・記録の書き込みの失敗）は記録に残り、MCP の `recent_log` で読めます。

## 置き場に残るものと、読める人

渡は、窓で見えたものを手元に残します。拡張によっては**他人の発言の本文がそのまま入ります**。

| 残るもの | 場所 | 形 | いつまで |
|---|---|---|---|
| 通信の記録（本文つき） | `captures/<所属>/<日付>.jsonl` | 平文 | `captureRetentionDays`（既定は期限なし） |
| 記録（見張りの値・操作・**通知の本文**・失敗） | `log/<所属>.jsonl` | 平文 | 期限なし（消す仕組みは無い） |
| 拡張の状態 | `state/<所属>/<拡張>.json` | 平文 | 拡張が消すまで |
| 発言の台帳（本文つき）と、出した知らせ | `ledger/<所属>.db` | SQLite（平文） | `ledgerRetentionDays`（既定は期限なし）。見たことのある発言の組（本文なし）は消さずに残す |
| ログイン（Cookie など） | `profiles/<所属>/` | Chrome のプロファイル | 消すまで |
| 合言葉 | `token` | 平文 | 消すまで |

**読める人**

- 常駐は起動のたびに、置き場を**いまの OS ユーザー・SYSTEM・Administrators だけ**に絞ります（Windows では親フォルダーの権限を継がないようにする。それ以外では `chmod 700`）。絞れなかったときは常駐は止まらず、`watari_status` の `homeAccess` に理由が出ます。
- 言い換えると、**同じ OS ユーザーで動くプロセスなら、どれでも全部を読めます**。WSL も、同じ Windows ユーザーとして `/mnt/<ドライブ>/` から読めます。
- MCP や常駐の口は、合言葉（`token`）を読めれば誰でもつながれます。合言葉は置き場の中にあるので、上と同じ範囲です。口は `127.0.0.1` だけで待ちます。
- 暗号化はしていません。PC そのものを守る（ディスクの暗号化・画面のロック）ことが前提です。

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
