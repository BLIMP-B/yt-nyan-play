# VS Code WebのWorkbenchスタイル

Microsoftの公式ソース、コミット a52d7d628e1a4c8fb9196cad37b3b456b88dadaa から2026-10-05にダウンロードしました。vscode.devへの直接アクセスは403のため、同じWorkbenchで使われる公式ソースを取得しました。

- workbench.css: src/vs/workbench/browser/media/style.css
- button.css: src/vs/base/browser/ui/button/button.css
- inputbox.css: src/vs/base/browser/ui/inputbox/inputBox.css
- light-modern.json / dark-modern.json: extensions/theme-defaults/themes/
- light-theme.css / dark-theme.css: ダウンロードしたcolorsをCSS変数へ変換

原本CSSは変更せず、配置調整を ../../style.css に置きます。LICENSE.txtを同梱しています。
取得元: https://github.com/microsoft/vscode/tree/a52d7d628e1a4c8fb9196cad37b3b456b88dadaa
