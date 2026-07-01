import { NextResponse } from 'next/server';

// サーバーレス関数の実行時間制限を延長 (Hobbyプランでは最大10秒だが、Groqの処理は数秒で終わる)
export const maxDuration = 10;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as Blob;
    
    if (!file) {
      return NextResponse.json({ error: '音声ファイルが見つかりません' }, { status: 400 });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'APIキーが設定されていません' }, { status: 500 });
    }

    // Groq の Whisper API (OpenAI互換) へ送信
    const groqFormData = new FormData();
    groqFormData.append('file', file, 'audio.wav');
    groqFormData.append('model', 'whisper-large-v3'); // Groqで最も精度と速度のバランスが良いモデル

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: groqFormData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Groq API Error:', errorText);
      return NextResponse.json({ error: `Groq API Error: ${response.statusText}` }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json({ text: data.text });
    
  } catch (error: any) {
    console.error('Transcribe API Error:', error);
    return NextResponse.json({ error: error.message || '内部サーバーエラー' }, { status: 500 });
  }
}
