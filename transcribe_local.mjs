import { pipeline } from '@huggingface/transformers';
import fs from 'fs';

async function main() {
  const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', { device: 'cpu' });
  const audio = fs.readFileSync('public/demo_input.mp4');
  
  const result = await transcriber(audio, { language: 'japanese', task: 'transcribe' });
  console.log('TRANSCRIPTION_RESULT:', result);
}
main();
