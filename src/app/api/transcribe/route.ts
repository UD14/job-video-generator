import { NextResponse } from 'next/server';
import { pipeline, env } from '@huggingface/transformers';

// Vercel環境でローカルモデルのロードを無効化
env.allowLocalModels = false;

// Node.js環境(サーバーレス)で実行するために設定
export const maxDuration = 10; // Vercel Hobbyプランの最大実行時間(10秒)

let transcriber: any = null;

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const audioFile = formData.get('audio');

    if (!audioFile || !(audioFile instanceof Blob)) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
    }

    // BlobをArrayBufferに変換
    const arrayBuffer = await audioFile.arrayBuffer();
    // クライアント側で16000HzにリサンプリングされたFloat32Arrayが直接送られてくるので、そのままFloat32Arrayとして復元
    const audioData = new Float32Array(arrayBuffer);

    // モデルの初期化（キャッシュして再利用）
    if (!transcriber) {
      transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
        device: 'auto', // サーバー側なので自動(wasm/cpu)に任せる
      });
    }

    // 文字起こし実行
    // pipelineにバイナリ(WAVのUint8Array)を渡すと自動でデコード・リサンプリングしてくれる
    const output = await transcriber(audioData, {
      chunk_length_s: 30,
      stride_length_s: 5,
      language: 'japanese',
      task: 'transcribe',
    });

    return NextResponse.json({ text: output.text });
  } catch (error: any) {
    console.error('API Transcribe Error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
