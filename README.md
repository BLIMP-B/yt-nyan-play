# にゃんぷれい / にゃんとーく〜Damare〜

YouTubeの動画ページに「再生」ボタンを追加し、動画のURL・再生指定・タイトルを、選択したDiscordのWebhookへ送信するChrome拡張機能です。

添付されたCRXの **v0.1.2 / Manifest V3** をもとに、GitHubで管理できる形に整理しました。

[Chromeウェブストア](https://chromewebstore.google.com/detail/nehmipbdoecdjefdlneejdaphpjbhlnf) · [元ファイルと変更点](docs/SOURCE.md) · [関連ソフトをまとめる方針](docs/INTEGRATION_PLAN.md)

過去チャット「YTにゃんぷれい_AHKClab」の取得可能なやり取りも参照し、**送信側のChrome拡張を残し、Discord読み上げBot・棒読みちゃん・ずんだもん音声生成・DiSpeak・AHKでのブラウザ再生を一つのデスクトップアプリへ統合する方針**を記録しています。

デスクトップ側は**常時稼働Windows PC上のDiscord.js Bot**とします。VOICEVOX以外の統合元は全機能の移植を対象とし、[機能対応表の方針](docs/FEATURE_PARITY.md)で確認状況と完了条件を管理します。

拡張側のSNS・ニコニコ動画対応と「再生可能なメディアのボタンから送信画面を開く」仕様は[送信側の拡張仕様](docs/EXTENSION_SPEC.md)に整理しています。PC側 v0.4.4は、マスタ共通再生・サーバー別独立再生、読み上げの方向別転送、Android管理導入と更新、複数アカウントのX読み上げ、棒読みちゃんのZIP取り込みと原文送信、VS Codeのライト/ダーク切替を備えます。CSV nyaan Viewerを参考に、月/太陽と操作ボタンをアイコン化し、アプリアイコンを左上の猫に統一しました。サーバー・チャンネルはDispeak風のチェックボックスで選択できます。Electronの日本語設定画面、常駐Discord.js Bot、VOICEVOX読み上げ、辞書・利用者ごとの声、専用ブラウザ再生、PC / Discord音声出力、永続キューをまとめています。Chrome拡張はYouTube向けv0.1.2を維持し、SNS向けの検出UIと統合元全機能の照合は残っています。

## にゃんとーく〜Damare〜を使う

[導入と操作](docs/DESKTOP.md) · [PC側の設計](docs/INTEGRATION_PLAN.md) · [機能対応と未解決点](docs/FEATURE_PARITY.md) · [LAN音声の設計](docs/LAN_VOICE_DESIGN.md) · [棒読みちゃん](docs/BOUYOMI_IMPORT.md) · [第三者ソフトウェア](THIRD_PARTY.md)

配布ファイルは [GitHub Releases](https://github.com/BLIMP-B/yt-nyan-play/releases) にまとめます。同じReleaseに、にゃんとーくのセットアップEXE・展開用ZIPと、にゃんぷれいのChrome拡張ZIPを置きます。WindowsはセットアップEXEで導入し、Chrome拡張ZIPは展開後にChromeの拡張機能画面から読み込んでください。Botトークン、受信チャンネルと音声チャンネル、VOICEVOX Engineを設定してください。エンジン・モデルはこの版に同梱していません。

ソースからはNode.js 22.12以上で `npm ci`、`npm start`。Windows上で `npm run dist:win` を実行するとインストーラーとZIPを作成します。Node.js / Discord.js / FFmpegとChrome拡張を同梱します。Chrome拡張の導入はChrome側で行います。

`npm test` は受信・権限・復旧・辞書・合成API・音声混合、`npm run smoke:desktop` はElectron画面と辞書保存を確認します。実Discord接続、実音声モデル、サイト別再生、長時間Windows稼働は利用環境での検証が必要です。統合元の全機能移植が完了した版ではありません。

## Chrome拡張の機能

- YouTubeの動画ページ・Shortsの操作領域に「再生」ボタンを追加。
- 複数のDiscord送信先を登録し、チェックした宛先へ送信。
- 「再生」「無限」の切り替え。「無限」は短縮URLに変換して指定文字を付けます。
- 現在の再生位置をURLの `t` パラメータに反映するモード（元ソースでは「調整中」）。
- 送信履歴を最大50件保存し、設定画面から宛先を選んで再送・削除。
- Webhookの表示切り替えと一覧でのマスク表示。

Chrome拡張はWebhookへ送信し、Windowsアプリが受信して再生します。

## Chromeで読み込む

1. このリポジトリをクローンするか、GitHubの **Code → Download ZIP** で取得して展開します。
2. Chromeで `chrome://extensions/` を開き、**デベロッパーモード**を有効にします。
3. **パッケージ化されていない拡張機能を読み込む**を押し、`extension/` フォルダを選びます。
4. 拡張機能のアイコンから設定画面を開き、送信先の表示名とDiscord Webhook URLを登録します。
5. YouTubeの動画ページを開き、「再生」から送信内容・モード・宛先を選んで送信します。

リポジトリ版は、既定の送信先を自動登録しません。最初に自分の送信先を設定してください。ソースを変更した後は、拡張機能を再読み込みしてYouTubeのタブも更新します。

送信形式の例：

```text
https://www.youtube.com/watch?v=VIDEO_ID再生
**【動画タイトル】**
```

「無限」では `https://youtu.be/VIDEO_ID無限` に変わります。「最初から」の通常モードはページのURLをそのまま使うため、元のURLに時刻指定がある場合は残ります。

## 構成

| ファイル | 役割 |
| --- | --- |
| `extension/manifest.json` | 権限、読み込み先、Manifest V3設定 |
| `extension/content-script.js` | YouTube上のボタン、送信ダイアログ、URLとタイトルの取得 |
| `extension/service-worker.js` | Discord WebhookへのPOSTと設定画面の起動 |
| `extension/options.html` / `options.css` / `options.js` | 宛先と履歴の管理画面 |
| `extension/furoneko70furoneko70.png` | 元CRXに含まれるアイコン |
| `scripts/` | ソース検査と拡張機能ZIPの作成 |

## 保存データと権限

`chrome.storage.sync` に送信先の表示名・Webhook URLと送信履歴を保存します。Chromeの同期設定により、同じアカウントのブラウザ間で同期される場合があります。履歴のWebhook表記はマスクされますが、送信先設定には送信に必要なURLが保存されます。

送信時は選択したDiscord Webhookへ、URL・指定文字・タイトルを含むメッセージをPOSTします。

| 権限・対象 | 用途 |
| --- | --- |
| `storage` | 送信先と送信履歴の保存 |
| `www.youtube.com` / `m.youtube.com` | YouTubeページへのUI追加 |
| `discord.com/api/webhooks/*` / `discordapp.com/api/webhooks/*` | 登録されたWebhookへの送信 |

Webhook URLには送信権限が含まれます。ソース・Issue・スクリーンショットへ実際のURLを掲載しないでください。元CRXに埋め込まれていたWebhook値はこのリポジトリから除外しています。元の送信先を管理している場合は、Discord側でそのWebhookを再発行してください。

## 検査・パッケージ作成

拡張機能の読み込みにビルドやnpm依存パッケージは不要です。管理用コマンドにはNode.js 22以上、ZIP作成にはPython 3.9以上を使用します。

```sh
npm run check
npm run package
```

`check` はJavaScript構文、manifest・HTMLからのファイル参照、埋め込みWebhookの不在を検査します。`package` は検査後、`dist/yt-nyan-play-0.1.2.zip` を作成します。ZIPの直下にmanifestが置かれ、ドキュメント・元CRX・ストア署名情報は入りません。

GitHub Actionsでも同じ検査とZIP作成を実行し、成果物を保存します。ストアへの自動公開は含みません。

## 検証範囲

ソース構文、ファイル参照、ZIP内容、空の既定送信先とユーザー指定宛先を使うバックグラウンド処理をローカルで確認しています。実際のYouTube画面での表示やDiscordへの実送信は未確認です。

YouTubeのDOM変更でボタンの表示位置が変わる可能性があります。モバイル向けURLもmanifestに含まれますが、各環境での動作は個別の確認が必要です。元ソースでは各Webhookの送信失敗を画面側が十分に表示せず、履歴に残る場合があります。

## ライセンス

添付CRX内にライセンスの記載はありません。コードとアイコンに新しい利用許諾は付与していません。
