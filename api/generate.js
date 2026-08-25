// このファイルはVercelの「サーバーレス関数」として /api/generate に自動公開されます。
// Gemini APIキーはここ(サーバー側)でしか使わないため、ブラウザ側には一切渡りません。
//
// 2段階構成にしています。
//   1回目: 出題条件にもとづいて問題・解答のドラフトを作成する
//   2回目: 1回目の内容をGemini自身に検算・チェックさせ、誤りがあれば修正した最終版を作る
// 特に計算問題・数式を含む記述問題での計算ミスを減らすことが目的です。

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

function difficultyLabel(d) {
  if (d === 'easy') return 'やさしいレベル（基礎の確認）';
  if (d === 'hard') return '難しいレベル（応用・発展）';
  return '標準的なレベル';
}

function difficultyInstruction(mode, total) {
  if (mode === 'progression') {
    const third = Math.max(1, Math.round(total / 3));
    return [
      `難易度は均一にせず、出題順に「やさしい→標準→難しい」の順で段階的に上げてください。`,
      `目安として、問1〜問${third}程度はやさしいレベル、問${third + 1}〜問${total - third}程度は標準的なレベル、残りの後半は難しいレベル（応用・発展）にしてください。`
    ].join('\n');
  }
  return `難易度: ${difficultyLabel(mode)}`;
}

function typeCountInstruction({ mcCount, descCount, calcCount }) {
  const parts = [];
  if (mcCount > 0) parts.push(`選択式（4択）を${mcCount}問`);
  if (descCount > 0) parts.push(`記述式を${descCount}問`);
  if (calcCount > 0) parts.push(`計算問題（穴埋め式）を${calcCount}問`);
  return `出題形式の内訳: ${parts.join('、')}（合計${mcCount + descCount + calcCount}問）。この内訳の数を厳密に守ってください。`;
}

function buildDraftPrompt({ subject, grade, topic, mcCount, descCount, calcCount, difficultyMode, totalPoints, referenceText, keywords, extraInstructions, sampleProblems }) {
  const total = mcCount + descCount + calcCount;
  const lines = [
    'あなたは学校の定期テストを作成するベテラン教員です。紙に印刷して配布する、正式な試験問題を作成します。',
    `教科: ${subject || '指定なし'}`,
    `対象学年: ${grade || '指定なし'}`,
    `出題範囲・テーマ: ${topic}`,
    difficultyInstruction(difficultyMode, total),
    typeCountInstruction({ mcCount, descCount, calcCount }),
    `配点合計: ${totalPoints}点（各問題のpointsの合計が概ね${totalPoints}になるように配分してください）`
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

function buildVerifyPrompt(draftQuestions) {
  return [
    'あなたは学校テストの採点主任です。以下は他の教員が作成した試験問題のドラフト(JSON)です。',
    '全ての問題について、あなた自身で実際に計算・検証をやり直し、内容を厳しくチェックしてください。',
    '特に注意すること:',
    '・type が "calculation" または "descriptive" で数式・計算を含む問題は、必ず自分で最初から計算し直し、answer が本当に正しいか確認すること。',
    '・選択式(multiple_choice)は、options の中に answer と完全に一致する文字列が存在するか確認すること。',
    '・explanation の内容が answer と矛盾していないか確認すること。',
    '・LaTeX記法($、\\frac{}{}、^{}、\\times など)が紛れ込んでいないか確認し、紛れ込んでいれば x^2 や a/b のようなプレーンテキストの書き方に直すこと。',
    '誤りが見つかった場合は answer と explanation を正しい内容に修正してください。問題文(question)・配点(points)・出題形式(type)は、明らかな誤り(選択式なのに数学的に正解が存在しないなど)がない限り変更しないでください。',
    '修正後、全ての問題を最初と全く同じJSONスキーマの形式で、questions配列として過不足なく出力してください（問題数を増減させないこと）。前置きや説明文は含めないでください。',
    '--- ドラフト ここから ---',
    JSON.stringify({ questions: draftQuestions }),
    '--- ドラフト ここまで ---'
  ].join('\n');
}

async function callGemini({ apiKey, model, prompt, temperature }) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA
        }
      })
    }
  );
  const data = await response.json();
  if (!response.ok) {
    const err = new Error(data.error?.message || 'Gemini APIでエラーが発生しました');
    err.status = response.status;
    throw err;
  }
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
  if (!text) throw new Error('Geminiから有効な返答が得られませんでした');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('応答をJSONとして解析できませんでした');
  }
  return parsed.questions || [];
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
    subject, grade, topic, difficultyMode, totalPoints,
    mcCount, descCount, calcCount,
    referenceText, keywords, extraInstructions, sampleProblems,
    skipVerification
  } = req.body || {};

  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    return res.status(400).json({ error: '出題範囲・テーマ(topic)が正しく送られていません' });
  }

  const safeMcCount = Math.max(0, Math.min(20, parseInt(mcCount, 10) || 0));
  const safeDescCount = Math.max(0, Math.min(20, parseInt(descCount, 10) || 0));
  const safeCalcCount = Math.max(0, Math.min(20, parseInt(calcCount, 10) || 0));
  let safeTotal = safeMcCount + safeDescCount + safeCalcCount;

  if (safeTotal <= 0) {
    return res.status(400).json({ error: '選択式・記述式・計算問題のいずれか1問以上を指定してください' });
  }
  if (safeTotal > 20) {
    return res.status(400).json({ error: '問題数の合計は20問以内にしてください' });
  }

  const safeDifficultyMode = ['easy', 'normal', 'hard', 'progression'].includes(difficultyMode) ? difficultyMode : 'normal';
  const safeTotalPoints = Math.min(200, Math.max(safeTotal, parseInt(totalPoints, 10) || 100));

  // 参考文章が長すぎるとトークンを圧迫するため一定文字数で切る
  const safeReferenceText = typeof referenceText === 'string' ? referenceText.slice(0, 6000) : '';
  const safeKeywords = typeof keywords === 'string' ? keywords.slice(0, 300) : '';
  const safeExtraInstructions = typeof extraInstructions === 'string' ? extraInstructions.slice(0, 800) : '';
  const safeSampleProblems = typeof sampleProblems === 'string' ? sampleProblems.slice(0, 2000) : '';

  try {
    const draftPrompt = buildDraftPrompt({
      subject: (subject || '').trim(),
      grade: (grade || '').trim(),
      topic: topic.trim(),
      mcCount: safeMcCount,
      descCount: safeDescCount,
      calcCount: safeCalcCount,
      difficultyMode: safeDifficultyMode,
      totalPoints: safeTotalPoints,
      referenceText: safeReferenceText,
      keywords: safeKeywords,
      extraInstructions: safeExtraInstructions,
      sampleProblems: safeSampleProblems
    });

    const draftQuestions = await callGemini({ apiKey, model, prompt: draftPrompt, temperature: 0.8 });

    if (skipVerification) {
      return res.status(200).json({ questions: draftQuestions, verified: false });
    }

    let finalQuestions = draftQuestions;
    let verified = true;
    try {
      const verifyPrompt = buildVerifyPrompt(draftQuestions);
      const verifiedQuestions = await callGemini({ apiKey, model, prompt: verifyPrompt, temperature: 0.1 });
      // 検算後も問題数が一致していれば採用。数が崩れていたらドラフトをそのまま使う(安全側に倒す)
      if (Array.isArray(verifiedQuestions) && verifiedQuestions.length === draftQuestions.length) {
        finalQuestions = verifiedQuestions;
      } else {
        verified = false;
      }
    } catch (verifyErr) {
      // 検算パスが失敗しても、ドラフトが使えるならそのまま返す
      verified = false;
    }

    return res.status(200).json({ questions: finalQuestions, verified });
  } catch (err) {
    return res.status(err.status || 500).json({ error: '生成中にエラーが発生しました: ' + err.message });
  }
}
