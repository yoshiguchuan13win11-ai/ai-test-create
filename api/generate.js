// このファイルはVercelの「サーバーレス関数」として /api/generate に自動公開されます。
// Gemini APIキーはここ(サーバー側)でしか使わないため、ブラウザ側には一切渡りません。
//
// layoutStyle によって2つの出題スタイルを切り替えます。
//   'standard' : 得点欄・氏名欄のある正式なテスト形式(1問ずつ、選択式/記述式/計算問題)
//   'drill'    : 大問+小問+ブラケット解答（［　　］）のコンパクトな問題集・ドリル形式
//
// どちらも2段階構成にしています。
//   1回目: 出題条件にもとづいて問題・解答のドラフトを作成する
//   2回目: 1回目の内容をGemini自身に検算・チェックさせ、誤りがあれば修正した最終版を作る
// 特に計算問題・数式を含む問題での計算ミスを減らすことが目的です。

const STANDARD_SCHEMA = {
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

const DRILL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    sections: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          instruction: { type: 'STRING' },
          subQuestions: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                question: { type: 'STRING' },
                answer: { type: 'STRING' }
              },
              required: ['question', 'answer']
            }
          }
        },
        required: ['instruction', 'subQuestions']
      }
    }
  },
  required: ['sections']
};

const MATH_NOTATION_RULES = [
  '',
  '【数式の書き方について・重要】',
  'LaTeX記法は絶対に使用しないでください。具体的には $ や \\( \\) で数式を囲むこと、\\frac{}{}、^{}、\\times、\\cdot、\\pi のようにバックスラッシュ(\\)を使う記法は禁止です。そのまま紙に印刷してPDFとして読める、ふつうの日本語の教科書と同じプレーンテキストの書き方にしてください。',
  '例: 累乗は x^2 のように半角のキャレット(^)を使う（$x^2$ とは書かない）。分数は a/b のように斜線で表す（\\frac{a}{b} とは書かない）。平方根はそのまま √ の記号を使う（\\sqrt{} とは書かない）。円周率はそのまま π を使う。掛け算は × を使うか、文字式ではそのまま隣に並べる（\\times は使わない）。'
];

function difficultyLabel(d) {
  if (d === 'easy') return 'やさしいレベル（基礎の確認）';
  if (d === 'hard') return '難しいレベル（応用・発展）';
  return '標準的なレベル';
}

function difficultyInstruction(mode, total) {
  if (mode === 'progression') {
    const third = Math.max(1, Math.round(total / 3));
    return [
      '難易度は均一にせず、出題順に「やさしい→標準→難しい」の順で段階的に上げてください。',
      `目安として、全体の前半約3分の1はやさしいレベル、中盤約3分の1は標準的なレベル、残りの後半は難しいレベル（応用・発展）にしてください。`
    ].join('\n');
  }
  return `難易度: ${difficultyLabel(mode)}`;
}

function commonConditionLines({ subject, grade, topic, referenceText, sampleProblems, keywords, extraInstructions }) {
  const lines = [
    `教科: ${subject || '指定なし'}`,
    `対象学年: ${grade || '指定なし'}`,
    `出題範囲・テーマ: ${topic}`
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

  return lines;
}

function typeCountInstruction({ mcCount, descCount, calcCount }) {
  const parts = [];
  if (mcCount > 0) parts.push(`選択式（4択）を${mcCount}問`);
  if (descCount > 0) parts.push(`記述式を${descCount}問`);
  if (calcCount > 0) parts.push(`計算問題（穴埋め式）を${calcCount}問`);
  return `出題形式の内訳: ${parts.join('、')}（合計${mcCount + descCount + calcCount}問）。この内訳の数を厳密に守ってください。`;
}

function buildStandardDraftPrompt(opts) {
  const { mcCount, descCount, calcCount, difficultyMode, totalPoints } = opts;
  const total = mcCount + descCount + calcCount;
  const lines = [
    'あなたは学校の定期テストを作成するベテラン教員です。紙に印刷して配布する、正式な試験問題を作成します。',
    ...commonConditionLines(opts),
    difficultyInstruction(difficultyMode, total),
    typeCountInstruction({ mcCount, descCount, calcCount }),
    `配点合計: ${totalPoints}点（各問題のpointsの合計が概ね${totalPoints}になるように配分してください）`,
    '選択式の場合、options には選択肢の本文だけを4つ入れてください（「ア」「イ」などの記号は付けないでください。表示側で付与します）。answer には正解の選択肢の文言をそのまま入れてください。',
    '記述式の場合、options は空配列にし、answer に模範解答を入れてください。あわせて answerLength に "short"（一行程度の短答）か "long"（数行の説明が必要な問題）のどちらかを入れてください。',
    '計算問題（穴埋め式）の場合、question には「3x + 5x =」のように、式の続きを答えさせる形の問題文を入れてください（説明や理由を問う文章にはしないでください）。options は空配列にし、answer には計算結果（例:「8x」）だけを入れてください。',
    '各問題には explanation として、採点者向けの簡潔な解説・採点基準を付けてください。',
    '問題文は生徒が読む正式な試験問題として自然な日本語にし、学年にふさわしい語彙・表現を使ってください。',
    ...MATH_NOTATION_RULES,
    '出力は指定されたJSONスキーマのオブジェクトのみとし、前置きや説明文、Markdown装飾は含めないでください。'
  ];
  return lines.join('\n');
}

function buildStandardVerifyPrompt(draftQuestions) {
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

function buildDrillDraftPrompt(opts) {
  const { sectionCount, subQuestionCount, difficultyMode } = opts;
  const lines = [
    'あなたは市販の問題集のような「計算ドリル・練習問題プリント」を作るベテラン教員です。',
    ...commonConditionLines(opts),
    difficultyInstruction(difficultyMode, subQuestionCount),
    `大問(セクション)の数: ${sectionCount}個`,
    `小問の合計数: ${subQuestionCount}問（${sectionCount}個の大問に、できるだけ均等になるよう振り分けてください）`,
    '各大問には instruction として、その大問全体に対する短い指示文を入れてください（例:「次の式を、文字式の表し方にしたがって表しなさい。」「次の数量を、文字を使った式で表しなさい。」など）。',
    '同じ大問内の小問(subQuestions)は、instructionで示した同じ種類の作業を繰り返す短い問題にしてください。1つの小問は基本的に1〜2行で完結する短いものにし、長い文章題ばかりにしないでください。',
    '各小問の question には問題文だけを入れ、末尾に「＝」やその他の解答用の記号・空欄は含めないでください（表示側で解答欄を追加します）。',
    '各小問の answer には、模範解答だけを簡潔に入れてください（説明文は不要です）。',
    ...MATH_NOTATION_RULES,
    '出力は指定されたJSONスキーマのオブジェクトのみとし、前置きや説明文、Markdown装飾は含めないでください。'
  ];
  return lines.join('\n');
}

function buildDrillVerifyPrompt(draftSections) {
  return [
    'あなたは問題集の校正担当です。以下は他の教員が作成した計算ドリルのドラフト(JSON)です。',
    '全ての小問について、あなた自身で実際に計算・検証をやり直し、answer が正しいか厳しくチェックしてください。',
    '誤りが見つかった場合は answer を正しい内容に修正してください。question の文言や大問の構成、小問の数は変更しないでください。',
    '・LaTeX記法($、\\frac{}{}、^{}、\\times など)が紛れ込んでいないか確認し、紛れ込んでいれば x^2 や a/b のようなプレーンテキストの書き方に直すこと。',
    '修正後、全ての大問・小問を最初と全く同じJSONスキーマの形式で、sections配列として過不足なく出力してください（大問・小問の数を増減させないこと）。前置きや説明文は含めないでください。',
    '--- ドラフト ここから ---',
    JSON.stringify({ sections: draftSections }),
    '--- ドラフト ここまで ---'
  ].join('\n');
}

async function callGemini({ apiKey, model, prompt, temperature, schema, key }) {
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
          responseSchema: schema
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
  return parsed[key] || [];
}

function countSubQuestions(sections) {
  return (sections || []).reduce((sum, s) => sum + ((s.subQuestions || []).length), 0);
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
  const body = req.body || {};
  const layoutStyle = body.layoutStyle === 'drill' ? 'drill' : 'standard';

  const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
  if (!topic) {
    return res.status(400).json({ error: '出題範囲・テーマ(topic)が正しく送られていません' });
  }

  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const grade = typeof body.grade === 'string' ? body.grade.trim() : '';
  const difficultyMode = ['easy', 'normal', 'hard', 'progression'].includes(body.difficultyMode) ? body.difficultyMode : 'normal';
  const referenceText = typeof body.referenceText === 'string' ? body.referenceText.slice(0, 6000) : '';
  const keywords = typeof body.keywords === 'string' ? body.keywords.slice(0, 300) : '';
  const extraInstructions = typeof body.extraInstructions === 'string' ? body.extraInstructions.slice(0, 800) : '';
  const sampleProblems = typeof body.sampleProblems === 'string' ? body.sampleProblems.slice(0, 2000) : '';
  const skipVerification = !!body.skipVerification;

  const shared = { subject, grade, topic, difficultyMode, referenceText, keywords, extraInstructions, sampleProblems };

  try {
    if (layoutStyle === 'drill') {
      const sectionCount = Math.max(1, Math.min(8, parseInt(body.sectionCount, 10) || 4));
      const subQuestionCount = Math.max(1, Math.min(60, parseInt(body.subQuestionCount, 10) || 20));

      const draftPrompt = buildDrillDraftPrompt({ ...shared, sectionCount, subQuestionCount });
      const draftSections = await callGemini({ apiKey, model, prompt: draftPrompt, temperature: 0.8, schema: DRILL_SCHEMA, key: 'sections' });

      if (skipVerification) {
        return res.status(200).json({ sections: draftSections, verified: false });
      }

      let finalSections = draftSections;
      let verified = true;
      try {
        const verifyPrompt = buildDrillVerifyPrompt(draftSections);
        const verifiedSections = await callGemini({ apiKey, model, prompt: verifyPrompt, temperature: 0.1, schema: DRILL_SCHEMA, key: 'sections' });
        if (Array.isArray(verifiedSections) && verifiedSections.length === draftSections.length && countSubQuestions(verifiedSections) === countSubQuestions(draftSections)) {
          finalSections = verifiedSections;
        } else {
          verified = false;
        }
      } catch (verifyErr) {
        verified = false;
      }

      return res.status(200).json({ sections: finalSections, verified });
    }

    // --- standard レイアウト ---
    const mcCount = Math.max(0, Math.min(20, parseInt(body.mcCount, 10) || 0));
    const descCount = Math.max(0, Math.min(20, parseInt(body.descCount, 10) || 0));
    const calcCount = Math.max(0, Math.min(20, parseInt(body.calcCount, 10) || 0));
    const safeTotal = mcCount + descCount + calcCount;

    if (safeTotal <= 0) {
      return res.status(400).json({ error: '選択式・記述式・計算問題のいずれか1問以上を指定してください' });
    }
    if (safeTotal > 20) {
      return res.status(400).json({ error: '問題数の合計は20問以内にしてください' });
    }
    const totalPoints = Math.min(200, Math.max(safeTotal, parseInt(body.totalPoints, 10) || 100));

    const draftPrompt = buildStandardDraftPrompt({ ...shared, mcCount, descCount, calcCount, totalPoints });
    const draftQuestions = await callGemini({ apiKey, model, prompt: draftPrompt, temperature: 0.8, schema: STANDARD_SCHEMA, key: 'questions' });

    if (skipVerification) {
      return res.status(200).json({ questions: draftQuestions, verified: false });
    }

    let finalQuestions = draftQuestions;
    let verified = true;
    try {
      const verifyPrompt = buildStandardVerifyPrompt(draftQuestions);
      const verifiedQuestions = await callGemini({ apiKey, model, prompt: verifyPrompt, temperature: 0.1, schema: STANDARD_SCHEMA, key: 'questions' });
      if (Array.isArray(verifiedQuestions) && verifiedQuestions.length === draftQuestions.length) {
        finalQuestions = verifiedQuestions;
      } else {
        verified = false;
      }
    } catch (verifyErr) {
      verified = false;
    }

    return res.status(200).json({ questions: finalQuestions, verified });
  } catch (err) {
    return res.status(err.status || 500).json({ error: '生成中にエラーが発生しました: ' + err.message });
  }
}
