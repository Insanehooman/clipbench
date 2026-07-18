// Runs entirely in a background thread so the page stays responsive
// while the speech model downloads and while it transcribes.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';

let transcriber = null;

self.onmessage = async (e) => {
  const { audioData, language } = e.data;
  try {
    if (!transcriber) {
      transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-small', {
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) {
            self.postMessage({ type: 'progress', loaded: p.loaded, total: p.total });
          }
        },
      });
    }
    self.postMessage({ type: 'status', message: 'transcribing' });
    const result = await transcriber(audioData, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      language: language === 'auto' ? undefined : language,
      task: 'transcribe',
    });
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
