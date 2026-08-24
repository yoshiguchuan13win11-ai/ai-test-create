// このファイルはVercelの「サーバーレス関数」として /api/generate に自動公開されます。
// Gemini APIキーはここ(サーバー側)でしか使わないため、ブラウザ側には一切渡りません。

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING', enum: ['multiple_choice', 'descriptive', 'calculation'] },
          question: { type: 'STRING' },
          points: { type: 'NUMBER' },
          options: { type: 'ARRAY', items: { type: 'STRING' } },
          answerLength: { type: 'STRING', enum: ['short', 'long'] },
          answer: { type: 'STRING' },
          explanation: { type: 'STRING' }
        },
        required: ['type', 'question', 'points', 'answer', 'explanation']
      }
    }
  },
  required: ['questions']
};

function formatInstruction(format) {
  if (format === 'mc') return '全ての問題を4択の選択式にしてください。';
  if (format === 'desc') return '全ての問題を記述式にしてください。options は空配列にしてください。';
  if (format === 'calc') return '全ての問題を、計算問題（穴埋め式）にしてください。「3x + 5x =」のように式の続きに空欄を置いて一言（数値や簡単な式）で答えさせる形式にし、説明を書かせる問題は含めないでください。options は空配列にしてください。';
  return '選択式（4択）・記述式・計算問題（穴埋め式）をバランスよく混在させてください。';
}

function difficultyInstruction(d) {
  if (d === 'easy') return 'やさしいレベル（基礎の確認）';
  if (d === 'hard') return '難しいレベル（応用・発展）';
  return '標準的なレベル';
}

function buildPrompt({ subject, grade, topic, format, difficulty, count, totalPoints, referenceText, keywords, extraInstructions, sampleProblems }) {
  const lines = [
    'あなたは学校の定期テストを作成するベテラン教員です。紙に印刷して配布する、正式な試験問題を作成します。',
    `教科: ${subject || '指定なし'}`,
    `対象学年: ${grade || '指定なし'}`,
    `出題範囲・テーマ: ${topic}`,
    `難易度: ${difficultyInstruction(difficulty)}`,
    `問題数: ${count}問`,
    `配点合計: ${totalPoints}点（各問題のpointsの合計が概ね${totalPoints}になるように配分してください）`,
    formatInstruction(format)
  ];

  if (referenceText && referenceText.trim()) {
    lines.push(
      '以下は出題の元になる参考文章です。この内容に基づいて出題してください（文章をそのまま書き写すだけの問題は避け、内容の理解を問う形にしてください）。',
      '--- 参考文章 ここから ---',
      referenceText.trim(),
      '--- 参考文章 ここまで ---'
    );
  }

  if (sampleProblems && sampleProblems.trim()) {
    lines.push(
      '以下は「このような形式・レベル感で出題してほしい」という例題です。内容をそのままコピーするのではなく、この例題と同じ種類の問題・同程度の難しさ・同じ書き方のスタイルで、新しい問題を作成してください。',
      '--- 出題例 ここから ---',
      sampleProblems.trim(),
      '--- 出題例 ここまで ---'
    );
  }

  if (keywords && keywords.trim()) {
    lines.push(`次のキーワードを、問題文または解答の中に必ず含めてください: ${keywords.trim()}`);
  }

  if (extraInstructions && extraInstructions.trim()) {
    lines.push(`追加の指示（最優先で反映すること）: ${extraInstructions.trim()}`);
  }

  lines.push(
    '選択式の場合、options には選択肢の本文だけを4つ入れてください（「ア」「イ」などの記号は付けないでください。表示側で付与します）。answer には正解の選択肢の文言をそのまま入れてください。',
    '記述式の場合、options は空配列にし、answer に模範解答を入れてください。あわせて answerLength に "short"（一行程度の短答）か "long"（数行の説明が必要な問題）のどちらかを入れてください。',
    '計算問題（穴埋め式）の場合、question には「3x + 5x =」のように、式の続きを答えさせる形の問題文を入れてください（説明や理由を問う文章にはしないでください）。options は空配列にし、answer には計算結果（例:「8x」）だけを入れてください。',
    '各問題には explanation として、採点者向けの簡潔な解説・採点基準を付けてください。',
    '問題文は生徒が読む正式な試験問題として自然な日本語にし、学年にふさわしい語彙・表現を使ってください。',
    '',
    '【数式の書き方について・重要】',
    'question、answer、explanation のいずれにおいても、LaTeX記法は絶対に使用しないでください。具体的には $ や \\( \\) で数式を囲むこと、\\frac{}{}、^{}、\\times、\\cdot、\\pi のようにバックスラッシュ(\\)を使う記法は禁止です。そのまま紙に印刷してPDFとして読める、ふつうの日本語の教科書と同じプレーンテキストの書き方にしてください。',
    '例: 累乗は x^2 のように半角のキャレット(^)を使う（$x^2$ とは書かない）。分数は a/b のように斜線で表す（\\frac{a}{b} とは書かない）。平方根はそのまま √ の記号を使う（\\sqrt{} とは書かない）。円周率はそのまま π を使う。掛け算は × を使うか、文字式ではそのまま隣に並べる（\\times は使わない）。',
    '出力は指定されたJSONスキーマのオブジェクトのみとし、前置きや説明文、Markdown装飾は含めないでください。'
  );

  return lines.join('\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POSTメソッドのみ対応しています' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'サーバーにGEMINI_API_KEYが設定されていません' });
  }

  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

  const {
    subject, grade, topic, format, difficulty, count, totalPoints,
    referenceText, keywords, extraInstructions, sampleProblems
  } = req.body || {};

  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    return res.status(400).json({ error: '出題範囲・テーマ(topic)が正しく送られていません' });
  }

  const safeCount = Math.min(20, Math.max(1, parseInt(count, 10) || 5));
  const safeFormat = ['mc', 'desc', 'calc', 'mixed'].includes(format) ? format : 'mixed';
  const safeDifficulty = ['easy', 'normal', 'hard'].includes(difficulty) ? difficulty : 'normal';
  const safeTotalPoints = Math.min(200, Math.max(safeCount, parseInt(totalPoints, 10) || 100));

  // 参考文章が長すぎるとトークンを圧迫するため一定文字数で切る
  const safeReferenceText = typeof referenceText === 'string' ? referenceText.slice(0, 6000) : '';
  const safeKeywords = typeof keywords === 'string' ? keywords.slice(0, 300) : '';
  const safeExtraInstructions = typeof extraInstructions === 'string' ? extraInstructions.slice(0, 800) : '';
  const safeSampleProblems = typeof sampleProblems === 'string' ? sampleProblems.slice(0, 2000) : '';

  try {
    const prompt = buildPrompt({
      subject: (subject || '').trim(),
      grade: (grade || '').trim(),
      topic: topic.trim(),
      format: safeFormat,
      difficulty: safeDifficulty,
      count: safeCount,
      totalPoints: safeTotalPoints,
      referenceText: safeReferenceText,
      keywords: safeKeywords,
      extraInstructions: safeExtraInstructions,
      sampleProblems: safeSampleProblems
    });

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.8,
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || 'Gemini APIでエラーが発生しました'
      });
    }

    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
    if (!text) {
      return res.status(500).json({ error: 'Geminiから有効な返答が得られませんでした' });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return res.status(500).json({ error: '応答をJSONとして解析できませんでした' });
    }

    return res.status(200).json({ questions: parsed.questions || [] });
  } catch (err) {
    return res.status(500).json({ error: 'サーバー内部エラー: ' + err.message });
  }
}
