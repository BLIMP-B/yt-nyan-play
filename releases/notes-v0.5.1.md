にゃんとーく〜Damare〜 v0.5.1 と にゃんぷれい v0.2.2 の試験版です。両方を更新してください。

- YouTubeのGoogleログインが内部ブラウザで拒否される問題に対し、通常Chrome / Edgeでログインし、にゃんぷれいの設定から同じPCのアプリへ明示的に引き継ぐ機能を追加しました。アプリの「再生アカウント」で接続コードをコピーして拡張の設定へ貼り付けます。GoogleのパスワードやGoogleドメインのCookieは取り込みません。
- VC接続先を設定したサーバーでは、読み上げ対象にチェックしていないテキストチャンネルでも「URL＋再生／無限／直接」と固定スキーマを受け付けます。通常文章の読み上げはチェックした対象だけです。サーバー別・マスタ共通の振り分け、開始位置、除外設定を保持します。
- キューへの登録、VC未設定、メディア受信OFF、不正形式をイベントログへ記録します。空の本文を受信した場合はMESSAGE CONTENT INTENTの確認を案内します。

`NyanTalk-Damare-Setup-0.5.1-x64.exe` はWindowsセットアップ、`NyanTalk-Damare-0.5.1-x64.zip` は展開用、`yt-nyan-play-0.2.2.zip` はChrome / Edge拡張です。既存の設定・辞書・Android端末は同じ保存先を使用します。

ログイン引き継ぎは試験用セッションで、実Chrome拡張から実Electronアプリへの保存・再起動・再生領域の共有を検証します。権限は試験用manifestで事前許可しており、実Googleアカウント・Premium適用・実YouTube本編の音声・実Discord VCへの到達は未確認です。サービス側のログイン・再生条件によっては再度引き継ぎが必要です。

操作の詳細: [YouTubeログインとチャット再生](https://github.com/BLIMP-B/yt-nyan-play/blob/codex/windows-desktop-bot/docs/YOUTUBE_LOGIN.md)
