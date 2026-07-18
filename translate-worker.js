// Runs entirely in a background thread so the page stays responsive
// while the translation model downloads and while it translates.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';

let translator = null;

self.onmessage = async (e) => {
  const { texts, srcLang, tgtLang } = e.data;
  try {
    if (!translator) {
      translator = await pipeline('translation', 'Xenova/m2m100_418M', {
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) {
            self.postMessage({ type: 'progress', loaded: p.loaded, total: p.total });
          }
        },
      });
    }
    self.postMessage({ type: 'status', message: 'translating' });
    const results = [];
    for (const text of texts) {
      if (!text || !text.trim()) { results.push(text); continue; }
      const out = await translator(text, { src_lang: srcLang, tgt_lang: tgtLang });
      results.push(out[0].translation_text);
    }
    self.postMessage({ type: 'done', results });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
