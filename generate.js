// このファイルはVercelの「サーバーレス関数」として /api/generate に自動公開されます。
// Gemini APIキーはここ(サーバー側)でしか使わないため、ブラウザ側には一切渡りません。

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      type: { type: 'STRING', enum: ['multiple_choice', 'descriptive'] },
      question: { type: 'STRING' },
      options: { type: 'ARRAY', items: { type: 'STRING' } },
      answer: { type: 'STRING' },
      explanation: { type: 'STRING' }
    },
    required: ['type', 'question', 'answer', 'explanation']
  }
};

function formatInstruction(format) {
  if (format === 'mc') return '全ての問題を4択の選択式にしてください。';
  if (format === 'desc') return '全ての問題を記述式（自由回答）にしてください。options は空配列にしてください。';
  return '選択式（4択）と記述式をバランスよく混在させてください。';
}

function difficultyInstruction(d) {
  if (d === 'easy') return 'やさしいレベル（基礎の確認）';
  if (d === 'hard') return '難しいレベル（応用・発展）';
  return '標準的なレベル';
}

function buildPrompt(topic, format, difficulty, count) {
  return [
    `あなたはテスト問題作成の専門家です。次のテーマについて、日本語で問題を${count}問作成してください。`,
    `テーマ: ${topic}`,
    `難易度: ${difficultyInstruction(difficulty)}`,
    formatInstruction(format),
    '選択式の場合は options に4つの選択肢を入れ、answer には正解の選択肢の文言をそのまま入れてください。',
    '記述式の場合は options を空配列にし、answer に模範解答を入れてください。',
    '各問題には explanation として、なぜその答えになるかの簡潔な解説を必ず付けてください。',
    '出力は指定されたJSONスキーマの配列のみとし、前置きや説明文は含めないでください。'
  ].join('\n');
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

  const { topic, format, difficulty, count } = req.body || {};

  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    return res.status(400).json({ error: '出題テーマ(topic)が正しく送られていません' });
  }

  const safeCount = Math.min(15, Math.max(1, parseInt(count, 10) || 5));
  const safeFormat = ['mc', 'desc', 'mixed'].includes(format) ? format : 'mixed';
  const safeDifficulty = ['easy', 'normal', 'hard'].includes(difficulty) ? difficulty : 'normal';

  try {
    const prompt = buildPrompt(topic.trim(), safeFormat, safeDifficulty, safeCount);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.9,
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

    let items;
    try {
      items = JSON.parse(text);
    } catch (e) {
      return res.status(500).json({ error: '応答をJSONとして解析できませんでした' });
    }

    return res.status(200).json({ items });
  } catch (err) {
    return res.status(500).json({ error: 'サーバー内部エラー: ' + err.message });
  }
}
