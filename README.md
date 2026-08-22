# AI 問題演習ノート セットアップ手順

## ファイル構成
```
gemini-mondai-note/
├── public/
│   └── index.html   ← 画面(見た目)
├── api/
│   └── generate.js  ← Geminiを呼び出す裏側の処理
├── package.json
└── README.md
```

## 手順

### 1. Gemini APIキーを取得
1. https://aistudio.google.com/apikey にアクセス
2. Googleアカウントでログイン
3. 「Create API key」→ 新しいキーを作成
4. 表示されたキーをコピーしておく(あとで使います)

### 2. GitHubにアップロード
1. GitHubで新しいリポジトリを作成(例: `gemini-mondai-note`)
2. このフォルダ一式(`public`, `api`, `package.json`)をアップロード
   - GitHub Desktopを使うか、GitHubのWeb画面から「Add file → Upload files」でOK

### 3. Vercelでデプロイ
1. https://vercel.com にログイン(GitHubアカウントでログイン可)
2. 「Add New → Project」
3. 先ほどのGitHubリポジトリを選択して「Import」
4. **重要**: デプロイ設定画面で「Environment Variables」を開き、以下を追加
   - Name: `GEMINI_API_KEY`
   - Value: (ステップ1でコピーしたキー)
5. 「Deploy」をクリック

### 4. 完成
数十秒でデプロイが終わると、`https://あなたのプロジェクト名.vercel.app` というURLが発行されます。
そこにアクセスすればテスト問題ジェネレーターが使えます。

## 仕組みの説明
- `public/index.html`:ブラウザで表示される画面。テーマ・形式・難易度・問題数を `/api/generate` に送る
- `api/generate.js`:Vercelの「サーバーレス関数」。ここでGeminiのAPIキーを安全に使い、Google側に問い合わせて問題データ(JSON)を受け取る
- APIキーはブラウザ側(index.html)には一切書かれていないので、他人に見られる心配がありません

## 注意点
- Gemini無料枠にはリクエスト数の上限があります。個人利用なら通常問題ありません。
- リンクを他人と共有すると、その人の利用分もあなたのAPIキーの使用量としてカウントされます。多人数に公開する場合はご注意ください。
- 生成された問題は保存されません(タブを閉じると消えます)。

## モデルを変更したい場合
Vercelの環境変数に `GEMINI_MODEL` を追加すると、使用するモデルを変更できます(未設定時は `gemini-3.5-flash`)。
1. Vercelのプロジェクト → Settings → Environment Variables
2. `GEMINI_MODEL` という名前で、モデル名(例: `gemini-3.5-flash-lite`)を Value に入力して追加
3. 再デプロイ(Deployments タブから redeploy)

最新のモデル名は https://ai.google.dev/gemini-api/docs/models で確認できます。
