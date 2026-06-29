'use client';

import { useState, useRef, useEffect } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export default function Home() {
  const [loaded, setLoaded] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  
  // 文字起こし用の状態
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribeProgress, setTranscribeProgress] = useState('');

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [telopText, setTelopText] = useState('ここに入力した文字がテロップになります');
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  
  const ffmpegRef = useRef<any>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    // クライアントサイドでのみFFmpegをインスタンス化
    ffmpegRef.current = new FFmpeg();
    load();
  }, []);

  const load = async () => {
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    const ffmpeg = ffmpegRef.current;
    
    ffmpeg.on('log', ({ message }: { message: string }) => {
      if (messageRef.current) messageRef.current.innerHTML = message;
      console.log(message);
    });

    ffmpeg.on('progress', ({ progress }: { progress: number }) => {
      setProgress(Math.round(progress * 100));
    });

    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    setLoaded(true);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setVideoFile(e.target.files[0]);
    }
  };

  // --- 自動文字起こし処理 (Transformers.js) ---
  const transcribeAudio = async () => {
    if (!videoFile) return;
    setIsTranscribing(true);

    // iOS Safari対策: クリックアクションの直後（同期または直後のマイクロタスク）でAudioContextを生成・再開する
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    const audioContext = new AudioContextClass({ sampleRate: 16000 });
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    setTranscribeProgress('動画から音声を抽出中...');
    
    try {
      setTranscribeProgress('動画から音声を抽出・解析中...');
      
      let audioBuffer: AudioBuffer;
      try {
        const arrayBuffer = await videoFile.arrayBuffer();
        audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      } catch (err) {
        // iOS Safari等で.mov等のデコードに失敗した場合のフォールバック
        setTranscribeProgress('標準抽出に失敗したため、FFmpegエンジンで音声抽出を試みます...');
        
        const ffmpeg = ffmpegRef.current;
        if (!ffmpeg) throw new Error('FFmpegが初期化されていません。リロードしてください。');

        const inputFileName = videoFile.name.includes('.') 
          ? `input_audio.${videoFile.name.split('.').pop()}`
          : 'input_audio.mp4';
        
        await ffmpeg.writeFile(inputFileName, await fetchFile(videoFile));
        
        await ffmpeg.exec([
          '-i', inputFileName,
          '-vn',              // 映像を除外
          '-acodec', 'pcm_s16le',  // WAV (PCM 16bit)
          '-ar', '16000',     // サンプルレート 16kHz
          '-ac', '1',         // モノラル
          'extracted_audio.wav'
        ]);

        const wavData = await ffmpeg.readFile('extracted_audio.wav');
        const wavBlob = new Blob([wavData as any], { type: 'audio/wav' });
        const wavArrayBuffer = await wavBlob.arrayBuffer();
        
        audioBuffer = await audioContext.decodeAudioData(wavArrayBuffer);
        
        try {
          await ffmpeg.deleteFile(inputFileName);
          await ffmpeg.deleteFile('extracted_audio.wav');
        } catch { /* 無視 */ }
      }
      
      const audioData = audioBuffer.getChannelData(0); // Float32Array (モノラル)
      await audioContext.close();

      // 4. Transformers.jsのWhisperモデルをロード（初回のみダウンロード）
      setTranscribeProgress('AIモデルを準備中... (初回はダウンロードに時間がかかります)');
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowLocalModels = false;
      
      // iOS Safariでのメモリ不足やクラッシュを回避するため、WASMの実行スレッドを1に制限
      if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }

      const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
        quantized: false, // 重要: iOS Safariで発生するONNXの量子化エラー(qdq_actions.cc)を回避するため非量子化モデルを使用
        progress_callback: (info: any) => {
          if (info.status === 'progress') {
            setTranscribeProgress(`AIモデルをダウンロード中: ${Math.round(info.progress)}%`);
          }
        }
      } as any);

      // 5. 推論の実行
      setTranscribeProgress('AIが音声を文字に変換中...');
      const output = await transcriber(audioData, {
        chunk_length_s: 30,
        stride_length_s: 5,
        language: 'japanese',
        task: 'transcribe',
      });

      // 6. 結果をテキストボックスに反映
      let transcribedText = '';
      if (Array.isArray(output)) {
        transcribedText = output.map(chunk => chunk.text).join(' ');
      } else {
        transcribedText = (output as any).text;
      }
      
      const trimmed = transcribedText.trim();
      if (trimmed) {
        setTelopText(trimmed);
      } else {
        alert('音声が検出されませんでした。動画に音声が含まれているか確認してください。');
      }
      
    } catch (error) {
      console.error('文字起こしエラー:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      alert(`文字起こしに失敗しました。\n\n詳細: ${errorMessage}\n\n動画に音声が含まれているか確認してください。`);
    } finally {
      setIsTranscribing(false);
      setTranscribeProgress('');
    }
  };

  // --- 動画合成処理 (FFmpeg.wasm) ---
  const processVideo = async () => {
    if (!videoFile) return;
    
    setIsProcessing(true);
    setProgress(0);
    
    const ffmpeg = ffmpegRef.current;
    
    try {
      await ffmpeg.writeFile('input.mp4', await fetchFile(videoFile));
      await ffmpeg.writeFile('font.otf', await fetchFile('/fonts/NotoSansJP.otf'));
      
      const escapedText = telopText.replace(/'/g, "\u2019").replace(/:/g, "\\:");

      // 画面下部に帯を引き、テロップを合成
      await ffmpeg.exec([
        '-i', 'input.mp4',
        '-vf', `drawbox=y=ih-ih/5:color=black@0.6:width=iw:height=ih/5:t=fill,drawtext=fontfile=font.otf:text='${escapedText}':fontcolor=white:fontsize=h/20:x=(w-text_w)/2:y=h-h/10-text_h/2`,
        '-c:v', 'libx264',
        '-c:a', 'copy',
        'output.mp4'
      ]);

      const data = await ffmpeg.readFile('output.mp4');
      const videoBlob = new Blob([data as any], { type: 'video/mp4' });
      const url = URL.createObjectURL(videoBlob);
      setOutputUrl(url);

    } catch (error) {
      console.error(error);
      alert('動画の処理中にエラーが発生しました。');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <main className="min-h-screen bg-gray-50 text-gray-900 font-sans p-8">
      <div className="max-w-2xl mx-auto bg-white shadow-xl rounded-xl p-8">
        <h1 className="text-3xl font-bold mb-6 text-center text-blue-600">動画テロップ自動合成 (AI文字起こし対応)</h1>
        
        {!loaded ? (
          <div className="flex flex-col items-center justify-center p-12 bg-gray-100 rounded-lg">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
            <p className="text-gray-600">動画処理エンジンを準備中...</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* 入力フォーム */}
            <div className="bg-blue-50 p-6 rounded-lg border border-blue-100 space-y-6">
              
              {/* 1. 動画アップロード */}
              <div>
                <label className="block text-sm font-semibold mb-2">1. 動画ファイルを選ぶ (.mp4)</label>
                <input 
                  type="file" 
                  accept="video/mp4,video/quicktime" 
                  onChange={handleFileChange}
                  className="block w-full text-sm text-gray-500
                    file:mr-4 file:py-2 file:px-4
                    file:rounded-full file:border-0
                    file:text-sm file:font-semibold
                    file:bg-blue-600 file:text-white
                    hover:file:bg-blue-700
                    cursor-pointer"
                />
              </div>

              {/* 2. AI文字起こし */}
              <div className="pt-4 border-t border-blue-200">
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-semibold">2. 自動文字起こし (オプション)</label>
                  <button
                    onClick={transcribeAudio}
                    disabled={!videoFile || isTranscribing}
                    className={`text-xs px-3 py-1.5 rounded font-bold text-white transition-colors
                      ${(!videoFile || isTranscribing) ? 'bg-gray-400 cursor-not-allowed' : 'bg-purple-600 hover:bg-purple-700'}`}
                  >
                    {isTranscribing ? '処理中...' : '動画から音声を抽出してAIで文字起こし'}
                  </button>
                </div>
                {transcribeProgress && (
                  <p className="text-xs text-purple-600 mb-2">{transcribeProgress}</p>
                )}
                <p className="text-xs text-gray-500 mb-2">
                  ※ブラウザ内でAIが動くため無料・安全ですが、精度が低めなので手直しが必要です。
                </p>
                <textarea 
                  value={telopText}
                  onChange={(e) => setTelopText(e.target.value)}
                  className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  rows={3}
                  placeholder="アピールポイントやテロップを入力してください"
                />
              </div>

              {/* 3. 動画合成 */}
              <div className="pt-4 border-t border-blue-200">
                <button 
                  onClick={processVideo} 
                  disabled={!videoFile || isProcessing || isTranscribing}
                  className={`w-full py-3 px-4 rounded-lg font-bold text-white transition-colors
                    ${(!videoFile || isProcessing || isTranscribing) ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'}`}
                >
                  {isProcessing ? `処理中... ${progress}%` : '3. テロップを合成して動画を作成'}
                </button>
              </div>
            </div>

            {/* 出力結果 */}
            {outputUrl && (
              <div className="mt-8 p-6 bg-green-50 rounded-lg border border-green-200">
                <h2 className="text-xl font-bold text-green-800 mb-4">✨ 動画が完成しました！</h2>
                <video src={outputUrl} controls className="w-full rounded-lg shadow-md mb-4" />
                <a 
                  href={outputUrl} 
                  download={`output_${Date.now()}.mp4`}
                  className="block text-center w-full py-3 px-4 bg-green-600 hover:bg-green-700 text-white font-bold rounded-lg transition-colors"
                >
                  動画をダウンロードする
                </a>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
