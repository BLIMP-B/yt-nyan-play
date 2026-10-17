# SoundCloudリンクの展開

2026年10月17日調査。短縮リンクの転送、曲のメタデータ取得、音声の配信URL取得を順に扱います。

| 入力 | 取得方法 |
| --- | --- |
| `https://on.soundcloud.com/短縮コード` | HTTP GETの転送応答の`Location`をたどり、SoundCloud公式ドメインの曲ページを取得する。短縮コードから投稿者・曲名のスラッグを生成する計算規則は公開資料で確認できない。 |
| `https://soundcloud.com/投稿者/曲` | 通常の曲ページ。公式APIの`/resolve?url=...`はこのパーマリンクからAPIリソースを取得する別の段階で、登録アプリのOAuth認証が必要。 |
| `https://w.soundcloud.com/player/?url=...` | `url`クエリに埋め込まれた曲/APIリソースを指す公式ウィジェット。oEmbedは曲URLからこの埋め込み情報を返す。 |
| 限定公開の`/s-...`や`secret_token` | 認証に必要な値なので除去しない。公開用の診断レポートでは伏せる。 |

短縮リンクのHTTP転送は既存の再生Cookie領域で取得し、転送先を許可した公式ドメインに限定します。転送回数は最大5回、処理は10秒を上限にし、中止にも従います。`on.`だけを削除したり、短縮コードを曲IDとみなしてURLを組み立てたりしません。

音声URLはメタデータの実際の配信形式から選択します。SoundCloudはAAC HLSへの移行を告知しており、`playback.media-streaming.soundcloud.cloud`が新形式の例として掲載されています。旧`*.sndcdn.com`とこの公式配信ドメインを受け付け、署名付きクエリは再生処理へそのまま渡します。

`scripts/verify-soundcloud-links.mjs`は同じ短縮リンク展開処理にNodeのHTTP GETを渡し、HTTPステータス・公式転送先をWindowsで記録します。Electronでの曲の実音声取得は別の実サイト試験へ記録します。HTTP転送の成功だけを音声再生の成功とは扱いません。

Windowsで新旧の指定リンクを確認したところ、`on.soundcloud.com/mnTxXSOAB7VR8gVSVm`と`on.soundcloud.com/mSGisM2jW5ftxL72bf`はいずれもHTTP 302で`https://soundcloud.com/uxu-169830723/2831ca85-5370-4159-a751-319145ce6c0f`へ転送されました。ここでは追跡クエリを表示から省いていますが、実装は転送先のクエリを保持します。

v0.5.20の実サイト試験にはローカル素材用HTTP(S)ハンドラーが残っており、転送元のURLに転送先の本文を返すなど、実際のネットワークとは異なる観測になり得ました。v0.5.21の実サイト試験ではこれを解除してから接続します。v0.5.20で表示された「ユーザーが見つからない」というページだけを根拠に、指定短縮リンクを無効と判断しません。

参照元:

- [yt-dlpメンテナによるSoundCloud短縮リンクのHTTP転送の説明](https://github.com/yt-dlp/yt-dlp/issues/12751)
- [SoundCloud公式APIガイド：URLのresolve・認証・再生](https://developers.soundcloud.com/docs/api/guide)
- [SoundCloud公式oEmbed](https://developers.soundcloud.com/docs/oembed)
- [SoundCloud公式：限定公開リンクのトークン](https://help.soundcloud.com/hc/en-us/articles/115003450427-Sharing-a-private-track-or-playlist-within-SoundCloud)
- [SoundCloud公式：AAC HLS移行と配信URL](https://developers.soundcloud.com/blog/api-streaming-urls/)
