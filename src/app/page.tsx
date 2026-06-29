'use client';

import { useState, useRef, useEffect } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export default function Home() {
  const [loaded, setLoaded] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [telopText, setTelopText] = useState('ここに入力した文字がテロップになります');
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  
  const ffmpegRef = useRef<any>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    // クライアントサイドでのみFFmpegをインスタンス化（SSR回避）
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

  const processVideo = async () => {
    if (!videoFile) return;
    
    setIsProcessing(true);
    setProgress(0);
    
    const ffmpeg = ffmpegRef.current;
    
    try {
      // 1. ユーザーの動画ファイルをFFmpeg仮想FSに書き込む
      await ffmpeg.writeFile('input.mp4', await fetchFile(videoFile));
      
      // 2. 日本語フォントを仮想FSに読み込む
      // サーバー上の public/fonts/NotoSansJP.otf から取得する
      await ffmpeg.writeFile('font.otf', await fetchFile('/fonts/NotoSansJP.otf'));
      
      // テロップのクォート等をエスケープ（FFmpegのdrawtext構文向け）
      const escapedText = telopText.replace(/'/g, "\u2019").replace(/:/g, "\\:");

      // 3. 動画処理コマンドの実行
      // 下部20%(ih/5)に黒い半透明(0.6)の帯を引き、その中央に白文字でテロップを描画
      await ffmpeg.exec([
        '-i', 'input.mp4',
        '-vf', `drawbox=y=ih-ih/5:color=black@0.6:width=iw:height=ih/5:t=fill,drawtext=fontfile=font.otf:text='${escapedText}':fontcolor=white:fontsize=h/20:x=(w-text_w)/2:y=h-h/10-text_h/2`,
        '-c:v', 'libx264',
        '-c:a', 'copy', // 音声はそのままコピー
        'output.mp4'
      ]);

      // 4. 結果を読み取ってBlob URLを作成
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
        <h1 className="text-3xl font-bold mb-6 text-center text-blue-600">動画テロップ自動合成 (ブラウザ完結)</h1>
        
        {!loaded ? (
          <div className="flex flex-col items-center justify-center p-12 bg-gray-100 rounded-lg">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
            <p className="text-gray-600">動画処理エンジン(FFmpeg.wasm)を準備中...</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* 入力フォーム */}
            <div className="bg-blue-50 p-6 rounded-lg border border-blue-100 space-y-4">
              <div>
                <label className="block text-sm font-semibold mb-2">1. 動画ファイルを選ぶ (.mp4)</label>
                <input 
                  type="file" 
                  accept="video/mp4" 
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

              <div>
                <label className="block text-sm font-semibold mb-2">2. 合成するテロップを入力</label>
                <input 
                  type="text" 
                  value={telopText}
                  onChange={(e) => setTelopText(e.target.value)}
                  className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="アピールポイントを入力してください"
                />
              </div>

              <button 
                onClick={processVideo} 
                disabled={!videoFile || isProcessing}
                className={`w-full py-3 px-4 rounded-lg font-bold text-white transition-colors
                  ${(!videoFile || isProcessing) ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'}`}
              >
                {isProcessing ? `処理中... ${progress}%` : 'テロップを合成して動画を作成'}
              </button>
            </div>

            {/* 処理ログ（デバッグ用） */}
            <div className="hidden">
              <p ref={messageRef} className="text-xs text-gray-400 font-mono"></p>
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
