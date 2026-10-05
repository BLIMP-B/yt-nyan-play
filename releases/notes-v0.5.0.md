にゃんとーく〜Damare〜の時報とAndroid起動復旧を追加した試験版です。同じReleaseに送信側Chrome拡張「にゃんぷれい」をまとめています。

## 配布物

- `NyanTalk-Damare-Setup-0.5.0-x64.exe`: Windows 10/11 x64インストーラー
- `NyanTalk-Damare-0.5.0-x64.zip`: 展開して実行するWindows版
- `yt-nyan-play-0.1.2.zip`: Chrome拡張。Chromeの拡張管理から読み込みます
- `SHA256SUMS.txt`: 配布ファイルのチェックサム

既存設定とAndroid端末データを保持します。Windows版にはNode.js・Discord.js・Opus・FFmpegを含みます。VOICEVOX Engineと声モデルは別途必要です。

## 時報

毎正時に「にゃんとーくが〇〇時をお知らせします」と3点の時報音を全接続VCへ流します。3点目の開始位置を正時に合わせて予約します。通常の読み上げに最優先で割り込み、待機中の読み上げを保持します。メディアは音量だけをフェードし、途中で自然終了しても再再生しません。

サーバーごとに複数の資料チャンネルを選択し、閲覧可能な全履歴を単語へ分解して、PC内の小型言語モデルで主語・述語のある意外な文章を生成します。管理導入するモデルはOllamaの`qwen3:0.6b`です。都度生成を基本とし、時報中に生成が間に合わない場合は日次24文へ自動で切り替えます。

生成文の名詞2語＋「フリーBGM」でYouTubeを検索し、別系統のBGMを重ねます。読み終わりから1.5秒待ち、1.5秒かけてフェードして停止します。YouTubeの検索・再生が失敗した場合は生成文のみ流します。

時報は既定で無効です。「時報」でSLMを導入し、資料チャンネルの履歴を取得、「文章生成を試す」「15秒後を正時として試す」で確認してから有効にしてください。共通告知だけの場合はSLM不要です。

## Android

固定3分の起動待ちを初期化進捗の監視へ変更しました。起動停滞時はデータを消去せず、ソフトウェア描画・コールドブートで一度復旧します。停止で待機を中止できます。既定の起動上限は1回12分です。

初回起動のランチャー応答停止がPlay画面を覆う場合の復旧を追加しました。Activityだけで判定せず、実際にPlayのウィンドウへフォーカスが移り安定するまで確認します。SDK・Androidバージョンの更新と既存AVDの保持に対応します。

## 検証と現在の制限

Linux・Windowsで101件の自動試験、実Electronの連続読み上げ・予約時報・メディア音声取り込み・Discord用Opus変換、Windowsパッケージ作成を確認しました。実WindowsのSLM生成は約0.4〜2.5秒でした。時報の3点目は予約時刻から約103ms後に音声取り込み側で検出しています。公式SDK・Google Play対応API35を導入し、最終試験では約180秒で起動しました。応答停止ダイアログのないPlay画面とログインボタンを実画像でも確認しています。

配布するソースは `11603f684cd6bfee92cd1860d203a698db4cfc78`、検証結果は [Windowsビルド・Android・SLM・音声試験](https://github.com/BLIMP-B/yt-nyan-play/actions/runs/37389870379) です。

**YouTube本編の実音声は未確認です。** 複数の公開動画・公式埋め込みをWindows・Linux・macOSで試しましたが、検証環境では「Sign in to confirm you’re not a bot」のログイン要求が出ています。時報BGMにも同じ条件が適用されます。アプリの「再生アカウント」でログインする経路はありますが、実Googleアカウント認証とPremium状態は未確認です。

ニコニコ本編の実音声とDiscord用音声変換は確認しています。実Bot認証でのDiscord VC到達、Google Playの実アカウント認証、長時間稼働は未確認です。端末と通信の遅延が加わるため、受信側スピーカーでの完全な正時一致は保証しません。

統合元の全機能移植が完了した版ではありません。詳細は[導入・現在の検証](https://github.com/BLIMP-B/yt-nyan-play/blob/codex/windows-desktop-bot/docs/DESKTOP.md)、[時報の設計](https://github.com/BLIMP-B/yt-nyan-play/blob/codex/windows-desktop-bot/docs/HOURLY_CHIME.md)、[機能対応表](https://github.com/BLIMP-B/yt-nyan-play/blob/codex/windows-desktop-bot/docs/FEATURE_PARITY.md)を参照してください。
