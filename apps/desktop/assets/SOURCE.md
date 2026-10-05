# アプリアイコン

左上のヘッダーと同じ `extension/furoneko70furoneko70.png` を `app.ico` へ形式変換しています。新たな図柄は描いていません。16、24、32、48、64、128、256pxのPNGフレームをICOに格納し、Windowsの実行ファイル・NSIS・ショートカット・ウィンドウ・トレイで使用します。

再生成: `npm run icon:build`。変換には同梱開発依存のElectron nativeImageを使用します。元画像とICOのSHA-256は `app-icon-source.json` に記録し、デスクトップ検査で照合します。Windows CIでは完成したEXE・インストーラーからアイコンを取得し、元ICOの32pxフレームと比較します。

元CRXのアイコンに新しい利用許諾は付与していません。
