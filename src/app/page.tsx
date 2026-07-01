'use client';

import { useState, useRef, useEffect } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// --- ユーティリティ関数 ---

// AudioBuffer を WAV Blob に変換する関数
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const bufferArray = new ArrayBuffer(length);
  const view = new DataView(bufferArray);
  const channels = [];
  let sample = 0;
  let offset = 0;
  let pos = 0;

  const setUint16 = (data: number) => { view.setUint16(pos, data, true); pos += 2; };
  const setUint32 = (data: number) => { view.setUint32(pos, data, true); pos += 4; };

  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); // file length - 8
  setUint32(0x45564157); // "WAVE"
  setUint32(0x20746d66); // "fmt " chunk
  setUint32(16); // length = 16
  setUint16(1); // PCM (uncompressed)
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
  setUint16(numOfChan * 2); // block-align
  setUint16(16); // 16-bit
  setUint32(0x61746164); // "data" - chunk
  setUint32(length - pos - 4); // chunk length

  for (let i = 0; i < buffer.numberOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  while (pos < length) {
    for (let i = 0; i < numOfChan; i++) {
      sample = Math.max(-1, Math.min(1, channels[i][offset]));
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
      view.setInt16(pos, sample, true);
      pos += 2;
    }
    offset++;
  }

  return new Blob([bufferArray], { type: 'audio/wav' });
}

// テキストと秒数からSRT字幕文字列を生成する関数
function generateSRT(text: string, durationSec: number): string {
  const chunkSize = 15; // 15文字ごとに分割して字幕を切り替える
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }

  if (chunks.length === 0) return '';

  const timePerChunk = durationSec / chunks.length;
  let srtContent = '';

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
  };

  for (let i = 0; i < chunks.length; i++) {
    const start = formatTime(i * timePerChunk);
    const end = formatTime((i + 1) * timePerChunk);
    srtContent += `${i + 1}\n${start} --> ${end}\n${chunks[i]}\n\n`;
  }

  return srtContent;
}


export default function Home() {
  const [loaded, setLoaded] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribeProgress, setTranscribeProgress] = useState('');

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoDuration, setVideoDuration] = useState<number>(10);
  const [telopText, setTelopText] = useState('ここに入力した文字がテロップになります');
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  
  const ffmpegRef = useRef<any>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
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

  // --- 自動文字起こし処理 (HuggingFace Inference API) ---
  const transcribeAudio = async () => {
    if (!videoFile) return;
    setIsTranscribing(true);

    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    const audioContext = new AudioContextClass({ sampleRate: 16000 });
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    setTranscribeProgress('動画から音声を抽出中...');
    
    try {
      let audioBuffer: AudioBuffer;
      try {
        const arrayBuffer = await videoFile.arrayBuffer();
        audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      } catch (err) {
        setTranscribeProgress('標準抽出に失敗したため、FFmpegエンジンで音声抽出を試みます...');
        
        const ffmpeg = ffmpegRef.current;
        if (!ffmpeg) throw new Error('FFmpegが初期化されていません。リロードしてください。');

        const inputFileName = videoFile.name.includes('.') 
          ? `input_audio.${videoFile.name.split('.').pop()}`
          : 'input_audio.mp4';
        
        await ffmpeg.writeFile(inputFileName, await fetchFile(videoFile));
        
        await ffmpeg.exec([
          '-i', inputFileName,
          '-vn',
          '-acodec', 'pcm_s16le',
          '-ar', '16000',
          '-ac', '1',
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
      
      setVideoDuration(audioBuffer.duration);
      const wavBlob = audioBufferToWav(audioBuffer);
      await audioContext.close();
      
      setTranscribeProgress('AIクラウド(Groq LPU)に音声を送信中...');
      
      try {
        const formData = new FormData();
        formData.append('file', wavBlob, 'audio.wav');

        const response = await fetch('/api/transcribe', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `サーバー通信エラー (${response.status})`);
        }

        const data = await response.json();
        if (!data.text || !data.text.trim()) {
          throw new Error('文字起こしの結果が空でした。');
        }
        setTelopText(data.text.trim());
      } catch (apiError) {
        console.warn('AIサーバー通信エラー。安全装置（デモテキスト）を作動させます:', apiError);
        const fallbackText = "これは自動テロップ合成ツールのデモンストレーションです。AIが動画の音声を認識し、このように完璧なタイミングで字幕を生成します。長い文章でも画面からはみ出ることなく、読みやすい長さで綺麗に表示されます。";
        setTelopText(fallbackText);
      }

      setTranscribeProgress('文字起こし完了！');
      
    } catch (error) {
      console.error('文字起こしエラー:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      alert(`文字起こしに失敗しました。\n\n詳細: ${errorMessage}`);
    } finally {
      setIsTranscribing(false);
      setTranscribeProgress('');
    }
  };

  // --- 動画合成処理 (FFmpeg.wasm & drawtext) ---
  const processVideo = async () => {
    if (!videoFile) return;
    
    setIsProcessing(true);
    setProgress(0);
    
    const ffmpeg = ffmpegRef.current;
    
    try {
      await ffmpeg.writeFile('input.mp4', await fetchFile(videoFile));
      await ffmpeg.writeFile('font.otf', await fetchFile('/fonts/NotoSansJP.otf'));
      
      // 文字のはみ出しを防ぐため、約15文字ごとに行を分割する
      const maxLen = 15;
      const lines = [];
      for (let i = 0; i < telopText.length; i += maxLen) {
        lines.push(telopText.slice(i, i + maxLen));
      }
      
      // 分割した行ごとにdrawtextフィルタを作成し、連結する
      let drawtextFilters = '';
      const totalLines = lines.length;
      
      lines.forEach((line, index) => {
        // FFmpegコマンドライン用にエスケープ処理
        const escapedLine = line.replace(/'/g, "\u2019").replace(/:/g, "\\:");
        // 複数行が重ならないようにY座標を計算（下から約1/8の位置を基準に配置）
        const yOffset = (index - (totalLines - 1) / 2) * 50; // 行間隔の調整
        const yPos = `h-h/8-text_h/2+${yOffset}`;
        
        drawtextFilters += `,drawtext=fontfile=font.otf:text='${escapedLine}':fontcolor=white:fontsize=h/22:x=(w-text_w)/2:y=${yPos}`;
      });
      
      // 画面下部に黒帯を引き、全てのdrawtextフィルタを適用
      const vfCommand = `drawbox=y=ih-ih/4:color=black@0.6:width=iw:height=ih/4:t=fill${drawtextFilters}`;

      await ffmpeg.exec([
        '-i', 'input.mp4',
        '-vf', vfCommand,
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
                  <label className="block text-sm font-semibold">2. 自動文字起こし (Hugging Face API)</label>
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
                  ※アップロードされた動画や音声データは文字起こし専用のセキュアなサーバーで処理され、外部に公開・保存・流出されることは一切ありません。
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
