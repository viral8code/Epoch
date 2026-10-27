# Epoch

Epoch は、プログラミング言語 [REWIND](https://github.com/viral8code/REWIND) 専用の統合開発環境です。Visual Studio 2022/2026 の操作感で、REWIND のプログラムを書き、ビルド（チェック）し、実行し、記録した実行をさかのぼってデバッグできます。

- 裏側（ファイル、プロセス、言語サーバーとデバッガーの仲介、検索）は Rust と Tauri 2 で実装しています。
- 編集部品は Monaco Editor です。日本語入力、複数カーソル、検索と置換、折りたたみ、ミニマップを使えます。
- 言語の解釈はしません。構文の色分けは `rewind editor-info` の語から作り、診断・補完・定義へ移動などは `rewind lsp` に問い合わせます（[REWIND のエディタ作成ガイド](https://github.com/viral8code/REWIND/blob/main/docs/editor-guide.md)の分担どおりです）。

## 主な機能

| 分類 | 機能 |
|---|---|
| 画面 | メニューと標準ツールバー、ソリューション エクスプローラー、ドキュメント アウトライン、ナビゲーション バー、エラー一覧、出力、ターミナル、検索結果、ドッキングするツール ウィンドウ、配色（ダーク・淡色・青） |
| 編集 | REWIND の色分け（`commit`・`revert`・`publish` などは専用の色）、IntelliSense（補完・ホバー・シグネチャ）、定義へ移動（F12）、参照（Shift+F12）、名前の変更（F2）、ドキュメントのフォーマット、クイック アクション、すべてに移動（Ctrl+T）、フォルダーを指定して検索/置換（Ctrl+Shift+F） |
| ビルドと実行 | チェック（Ctrl+Shift+B）、デバッグなしで開始（Ctrl+F5）、標準入力への入力、テスト、`rewind build`、`.rwc` へのコンパイル、プロファイル、許可する効果（`--allow-effects`）の切り替え |
| デバッグ | F5 で `--record-mode debug` の記録を取りながら実行し、`rewind dap` で開きます。ブレークポイント（F9）、ステップ イン/オーバー、**ステップ バック（Alt+[）と逆方向に続行（Alt+F5）**、ローカル、ウォッチ、呼び出し履歴、イミディエイト ウィンドウ、ホバーで記録された値を表示 |
| REWIND 固有 | 履歴タイムライン：記録の中の commit・revert・publish をタスクごとの列に並べ、revert から戻り先の commit へ弧を描きます。クリックするとソースの行へ移動します |

## 必要なもの

- Windows 10/11（x64）。WebView2 ランタイム（Windows 11 には標準で入っています）
- REWIND 4.0.0 以降の SDK（`rewind` コマンド）。PATH から探すか、ツール ＞ オプション ＞ REWIND ＞ ツールチェーンで場所を指定します。

## ビルド

Rust 1.98.1（`rust-toolchain.toml` で固定）と Node.js 20 以降が必要です。

```sh
cd ui
npm ci
npm run build
cd ..
cargo build --release
```

`target/release/epoch.exe` ができます。インストーラー（MSI / NSIS）が必要なら、`cargo install tauri-cli --version "^2"` のあと `cargo tauri build` を実行します。

画面を変えたときは `ui` で `npm run build` をやり直してから、`cargo build` します（画面はコンパイル時に実行ファイルへ埋め込まれます）。

## テスト

```sh
cargo test
cargo clippy --all-targets
```

## 安全のための設計

- **ファイル操作は開いたフォルダーの中だけ**です。パスはすべて Rust 側でシンボリック リンクを解決してから確かめます。フォルダーの外のファイルは、ダイアログで選んだものだけを開けます。削除はごみ箱へ移します。
- **保存は一時ファイルと名前の変更で行います**。途中で止まっても、ファイルが半分だけ書かれることはありません。ほかのプログラムがファイルを変えていたら、上書きする前に確かめます。
- **コードは明示した操作でだけ実行します**。フォルダーを開いただけでは何も実行しません。プログラムは `rewind` へ引数の配列で渡し、シェルを通しません。許可する効果も、名前の一覧として検証してから渡します。
- **開いたフォルダーの中にある `rewind` は実行しません**。リポジトリに仕込まれた実行ファイルを起動しないためです。
- 画面からは、Rust 側で許可したコマンドしか呼べません（Tauri の capability と app manifest）。言語サーバーとデバッガーへの要求も、使うメソッドだけを通します。受け取るメッセージには大きさの上限があります。
- 画面はネットワークから何も読み込みません（厳しい Content-Security-Policy）。ファイル名や診断などの文字列は、HTML ではなくテキストとして表示します。
- Monaco 0.57 が同梱する DOMPurify 3.4.15 には既知の脆弱性があるため、修正版の 3.4.17 に差し替えてバンドルしています（`ui/build.mjs`）。
- 見えない文字や双方向制御文字は、エディターで強調表示します（Trojan Source 対策）。

## 構成

```
src/            Rust（Tauri のコマンド）
  workspace.rs  パスの検証（フォルダーの外へ出さない）
  files.rs      読み書き（原子的な保存、衝突の検出、ごみ箱への削除）
  rpc.rs        Content-Length 形式の JSON（LSP と DAP 共通、上限つき）
  lsp.rs        rewind lsp との仲介
  dap.rs        rewind dap との仲介（記録の再生デバッグ）
  tasks.rs      run / check / test / build / compile / profile / doc
  search.rs     ファイル一覧、フォルダー内の検索と置換
  timeline.rs   記録から commit・revert・publish を取り出す
ui/src/         画面（Monaco と、その周りの IDE）
capabilities/   画面に許すコマンドの一覧
```

## ライセンス

MIT License です。詳しくは [LICENSE](LICENSE) を参照してください。同梱する Monaco Editor（MIT）と DOMPurify（Apache-2.0 / MPL-2.0）のライセンス表示は、ビルド時に `ui/dist/app.js.LEGAL.txt` へ出力されます。
