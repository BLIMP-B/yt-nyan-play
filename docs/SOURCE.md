# 元ファイルと取り込み内容

## 出典

- ユーザー提供ファイル: `nehmipbdoecdjefdlneejdaphpjbhlnf.crx`
- CRX形式: v3
- manifestの名称: YTにゃんぷれい
- manifestのバージョン: `0.1.2`
- ストアの拡張機能ID: `nehmipbdoecdjefdlneejdaphpjbhlnf`
- ストアURL: https://chromewebstore.google.com/detail/nehmipbdoecdjefdlneejdaphpjbhlnf
- 添付CRXのSHA-256: `d553a967b7a5c968f72013102cf395ab67999ca0e843ae82b7f94b536fac03a7`
- 整理日: 2026-10-05

ストアページの本文は取得できなかったため、機能とバージョンの説明は添付CRXのmanifestと実装に基づきます。最新ストア版と同一であることは確認していません。

## 変更点

1. CRXから7つの実行用ファイルを`extension/`へ展開。テキストの改行はLFに統一し、アイコンはそのまま保持。
2. `manifest.json`のストア自動追加項目`update_url`を除外し、JSONの字下げを整形。権限とバージョンは維持。
3. `service-worker.js`の埋め込み既定Webhook URLを空に変更し、値が空なら既定宛先を登録しないガードを追加。設定画面で登録した宛先への送信処理は維持。
4. ストア署名用の`_metadata/verified_contents.json`と元CRXはリポジトリ・配布ZIPに含めない。
5. README、検査・ZIP作成スクリプト、GitHub Actionsを追加。

元CRX内の送信用Webhookは実際にPOSTできる認証情報のため、値・元CRX・その復元コピーは登録していません。元のWebhookを管理している場合は、Discord側で再発行してください。

パッケージ化されていない拡張機能はストア版と異なる拡張機能IDを持つ場合があります。ストア版の送信先・履歴が自動的に引き継がれることは想定していません。

## 元の実行用ファイルのハッシュ

設計の参考として、過去チャット「YTにゃんぷれい_AHKClab」の取得可能な直近5ターンも確認しました。関連ファイル本体は未取得です。統合方針と確認範囲は[INTEGRATION_PLAN.md](INTEGRATION_PLAN.md)に記録しています。チャット本文・ログ・認証情報をそのまま公開することはしていません。

取り込み元の特定用です。ハッシュからWebhook値を復元することはできません。

| 元CRX内のファイル | SHA-256 |
| --- | --- |
| `content-script.js` | `f25a8553e8b850b9e76f9148a433733a2925df83d35ba1f3a6b06a55fb208fe8` |
| `furoneko70furoneko70.png` | `cf3bcffe5e5999d5aecf8c096e64306a0af20fbf6adee537acb273443eee5535` |
| `manifest.json` | `2d28b86310a786b93295f551df4fc0c0a3f546f9689e124645f7902a38eeb066` |
| `options.css` | `97405e09bac8ea4e6c23b3534e7c378b90f856bcb4d7abd85339b89ab9857734` |
| `options.html` | `b80a6b91274b9b2e860769c2c2c43bcd836fe7c5799d08ecbef62601e66f5172` |
| `options.js` | `19e14255f7413bca6e52706dc7c7e104b9c1b8e7a327d984de7c1f17af03fa60` |
| `service-worker.js` | `81d8908fbfba31a80c69437a9c3d9e2cb4adf7dc1a0527ef484237742467962e` |
