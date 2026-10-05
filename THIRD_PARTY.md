# 第三者のソフトウェアと音声

本アプリの依存バージョンは `package-lock.json` に固定しています。配布物に含まれる各パッケージの LICENSE / NOTICE と、Electron同梱の `LICENSE` / `LICENSES.chromium.html` を参照してください。

| ソフトウェア | 用途 | 公開元・利用許諾 |
| --- | --- | --- |
| Electron / Chromium / Node.js | Windowsアプリと専用ブラウザ | [Electron](https://github.com/electron/electron) MIT、Chromium等は同梱NOTICE |
| discord.js / @discordjs/voice | Discord Botと音声接続 | [discord.js](https://github.com/discordjs/discord.js) Apache-2.0 |
| @snazzah/davey | Discord DAVE音声暗号化 | [davey](https://github.com/Snazzah/davey) MIT |
| opusscript / libopus | Opus音声エンコード | [opusscript](https://github.com/abalabahaha/opusscript) MIT、libopus BSD |
| re2-wasm / RE2 | 辞書の正規表現 | [re2-wasm](https://github.com/google/re2-wasm) Apache-2.0、RE2 BSD |
| kuromoji / IPADIC | 時報資料の日本語形態素解析 | [kuromoji.js](https://github.com/takuyaa/kuromoji.js) Apache-2.0、IPADICは辞書付属の利用許諾を参照 |
| ffmpeg-static / FFmpeg | 音声のPCM変換 | [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) GPL-3.0-or-later。バイナリ版は b6.1.1。対応ソース・ビルド情報は同リポジトリの [リリース](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1) と [FFmpeg](https://ffmpeg.org/download.html) を参照 |

VOICEVOX Engine・音声モデル・exVOICE素材・棒読みちゃんは現在のインストーラーに含めません。ユーザーが用意したエンジンのAPIを利用、または選択したエンジン実行ファイルをアプリから起動します。音声生成は `VOICEVOX:ずんだもん` と明記し、[VOICEVOX利用規約](https://voicevox.hiroshiba.jp/term/) と [ずんだもんの規約](https://zunko.jp/con_ongen_kiyaku.html) に従って使用してください。

DiSpeak 2.6.6 ([公開ソース](https://github.com/yudukiak/DiSpeak)、MIT) は機能の調査資料です。ソースをそのまま取り込んでいません。元CRXのコード・アイコンには新たな利用許諾を付与していません。未確認の第三者素材の再配布は含めていません。

VS CodeのWorkbench/Button/InputBoxのCSS、Light Modern/Dark ModernテーマとMIT LICENSEを、Microsoftの公式リポジトリの固定コミットから取得し `apps/desktop/renderer/vendor/vscode/` に保存しています。取得元・コミットは同フォルダの `SOURCE.md` を参照してください。VS Code WebのホストからCSSを直接取得できなかったため、Web/Desktopで共有する公式ソースを使用しています。

操作アイコンは [Lucide](https://lucide.dev/) 0.468.0 のSVGを使用します。使用するアイコンとISC/MIT LICENSEを `apps/desktop/renderer/vendor/lucide/` に保存しています。月・太陽と操作ボタンは [CSV nyaan Viewer](https://github.com/BLIMP-B/csv-nyaan-viewer) のUIを参考にしています。

fast-xml-parser (MIT) はSDK・棒読みちゃん設定のXML読み込み、fflate (MIT) はZIPの展開に使います。Android SDK/Emulator/Google Playイメージは利用者が規約を確認した後にGoogleの公式配布から取得し、Windowsパッケージへ事前同梱しません。JavaはEclipse Temurin (GPL-2.0 with Classpath Exception) の公式配布を取得し、付属LICENSE/NOTICEを保持します。

棒読みちゃんBeta21のユーザー共有ZIPに含まれるReadMeは無許可の再頒布を禁止しています。元本体・AquesTalk・個人設定は公開配布せず、利用者のZIPをローカルへ取り込む方式です。X API2の認証とGoogle Playログインは利用者自身のアカウントで行います。

時報のローカルSLMは[Ollama](https://github.com/ollama/ollama)（MIT）の公式Windows配布と[Qwen3-0.6B](https://huggingface.co/Qwen/Qwen3-0.6B)（Apache-2.0）を必要に応じて管理取得します。Ollama同梱のLICENSE/NOTICEを保持し、モデルの利用許諾は配布元を参照してください。インストーラーへの事前同梱は行いません。
