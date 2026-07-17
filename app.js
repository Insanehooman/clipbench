import { FFmpeg } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
import { fetchFile, toBlobURL } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js';

// ============================================================
// Clipbench — client-side clip tool
// Everything below runs in the visitor's browser. The only
// network calls are: loading this page, loading the ffmpeg.wasm
// engine (~30MB, cached after first load), and loading one font
// file used for burned-in captions. The video itself never
// leaves the device.
// ============================================================

const state = {
  file: null,
  duration: 0,
  videoWidth: 0,
  videoHeight: 0,
  segments: [],       // [{start,end,keep:boolean}]
  captions: [],        // [{id,start,end,text}]
  cropXRatio: 0.5,      // 0..1, center of crop window horizontally
  ffmpeg: null,
  ffmpegLoaded: false,
};

const $ = (id) => document.getElementById(id);

const els = {
  fileInput: $('fileInput'),
  dropZone: $('dropZone'),
  stageUpload: $('stage-upload'),
  stageBench: $('stage-bench'),
  stageResult: $('stage-result'),
  previewVideo: $('previewVideo'),
  cropFrame: $('cropFrame'),
  captionPreview: $('captionPreview'),
  playBtn: $('playBtn'),
  timeReadout: $('timeReadout'),
  cropSlider: $('cropSlider'),
  cropXLabel: $('cropXLabel'),
  threshSlider: $('threshSlider'),
  threshLabel: $('threshLabel'),
  gapSlider: $('gapSlider'),
  gapLabel: $('gapLabel'),
  analyzeBtn: $('analyzeBtn'),
  spliceCanvas: $('spliceCanvas'),
  trimStats: $('trimStats'),
  addCaptionBtn: $('addCaptionBtn'),
  captionList: $('captionList'),
  renderBtn: $('renderBtn'),
  renderProgress: $('renderProgress'),
  progressFill: $('progressFill'),
  progressLabel: $('progressLabel'),
  logOutput: $('logOutput'),
  resultVideo: $('resultVideo'),
  downloadLink: $('downloadLink'),
  startOverBtn: $('startOverBtn'),
};

function showStage(name) {
  ['stage-upload', 'stage-bench', 'stage-result'].forEach((id) => {
    $(id).classList.toggle('stage--active', id === `stage-${name}`);
  });
}

function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ------------------------------------------------------------
// Upload
// ------------------------------------------------------------
els.fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
});

['dragover', 'dragleave', 'drop'].forEach((evt) => {
  els.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropZone.classList.toggle('dragover', evt === 'dragover');
    if (evt === 'drop' && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
});

function loadFile(file) {
  state.file = file;
  const url = URL.createObjectURL(file);
  els.previewVideo.src = url;
  els.previewVideo.addEventListener('loadedmetadata', () => {
    state.duration = els.previewVideo.duration;
    state.videoWidth = els.previewVideo.videoWidth;
    state.videoHeight = els.previewVideo.videoHeight;
    els.timeReadout.textContent = `0:00 / ${fmtTime(state.duration)}`;
    setupCropFrame();
    showStage('bench');
    analyzeSilence(); // auto-run once on load
  }, { once: true });
}

// ------------------------------------------------------------
// Transport
// ------------------------------------------------------------
els.playBtn.addEventListener('click', () => {
  if (els.previewVideo.paused) { els.previewVideo.play(); els.playBtn.textContent = '⏸ pause'; }
  else { els.previewVideo.pause(); els.playBtn.textContent = '▶ play'; }
});
els.previewVideo.addEventListener('timeupdate', () => {
  els.timeReadout.textContent = `${fmtTime(els.previewVideo.currentTime)} / ${fmtTime(state.duration)}`;
  updateCaptionPreview();
});
els.previewVideo.addEventListener('ended', () => { els.playBtn.textContent = '▶ play'; });

function updateCaptionPreview() {
  const t = els.previewVideo.currentTime;
  const active = state.captions.find(c => t >= c.start && t <= c.end);
  els.captionPreview.textContent = active ? active.text : '';
}

// ------------------------------------------------------------
// Crop frame (draggable 9:16 window over a landscape source)
// ------------------------------------------------------------
function setupCropFrame() {
  const isLandscape = state.videoWidth / state.videoHeight > 9 / 16;
  els.cropFrame.classList.toggle('active', isLandscape);
  renderCropFrame();
}

function renderCropFrame() {
  if (!state.videoWidth) return;
  const wrapRect = $('previewWrap').getBoundingClientRect();
  // displayed video box within the wrap (object-fit: contain)
  const srcRatio = state.videoWidth / state.videoHeight;
  const wrapRatio = wrapRect.width / wrapRect.height;
  let dispW, dispH, offX, offY;
  if (srcRatio > wrapRatio) {
    dispW = wrapRect.width; dispH = dispW / srcRatio;
    offX = 0; offY = (wrapRect.height - dispH) / 2;
  } else {
    dispH = wrapRect.height; dispW = dispH * srcRatio;
    offY = 0; offX = (wrapRect.width - dispW) / 2;
  }
  const cropDispW = dispH * (9 / 16);
  const maxX = dispW - cropDispW;
  const left = offX + state.cropXRatio * maxX;
  els.cropFrame.style.left = `${left}px`;
  els.cropFrame.style.width = `${cropDispW}px`;
  els.cropFrame.style.top = `${offY}px`;
  els.cropFrame.style.height = `${dispH}px`;
}
window.addEventListener('resize', renderCropFrame);

els.cropSlider.addEventListener('input', () => {
  state.cropXRatio = els.cropSlider.value / 100;
  const labels = ['left', 'left-of-center', 'center', 'right-of-center', 'right'];
  const idx = Math.min(4, Math.floor(els.cropSlider.value / 25));
  els.cropXLabel.textContent = labels[idx];
  renderCropFrame();
});

// drag directly on the frame too
let dragging = false;
els.cropFrame.addEventListener('mousedown', () => dragging = true);
window.addEventListener('mouseup', () => dragging = false);
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const wrapRect = $('previewWrap').getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - wrapRect.left) / wrapRect.width));
  state.cropXRatio = ratio;
  els.cropSlider.value = Math.round(ratio * 100);
  renderCropFrame();
});

// ------------------------------------------------------------
// Silence detection (Web Audio API)
// ------------------------------------------------------------
els.threshSlider.addEventListener('input', () => {
  els.threshLabel.textContent = `${els.threshSlider.value} dB`;
});
els.gapSlider.addEventListener('input', () => {
  els.gapLabel.textContent = `${els.gapSlider.value}s`;
});
els.analyzeBtn.addEventListener('click', analyzeSilence);

async function analyzeSilence() {
  if (!state.file) return;
  els.analyzeBtn.textContent = 'Scanning…';
  els.analyzeBtn.disabled = true;
  try {
    const arrayBuffer = await state.file.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));

    const channels = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) channels.push(audioBuffer.getChannelData(c));
    const sampleRate = audioBuffer.sampleRate;
    const windowSize = Math.floor(sampleRate * 0.05); // 50ms windows
    const totalWindows = Math.floor(audioBuffer.length / windowSize);
    const dbSeries = new Float32Array(totalWindows);

    for (let w = 0; w < totalWindows; w++) {
      let sumSq = 0;
      const start = w * windowSize;
      for (let i = 0; i < windowSize; i++) {
        let sample = 0;
        for (const ch of channels) sample += ch[start + i] || 0;
        sample /= channels.length;
        sumSq += sample * sample;
      }
      const rms = Math.sqrt(sumSq / windowSize);
      dbSeries[w] = rms > 0 ? 20 * Math.log10(rms) : -100;
    }

    const threshold = parseFloat(els.threshSlider.value);
    const minGap = parseFloat(els.gapSlider.value);
    const windowDur = windowSize / sampleRate;
    const minGapWindows = Math.ceil(minGap / windowDur);
    const padding = 0.15; // seconds of breathing room kept around speech

    // find silent runs
    const silentRuns = [];
    let runStart = null;
    for (let w = 0; w <= totalWindows; w++) {
      const isSilent = w < totalWindows && dbSeries[w] < threshold;
      if (isSilent && runStart === null) runStart = w;
      if (!isSilent && runStart !== null) {
        if (w - runStart >= minGapWindows) silentRuns.push([runStart * windowDur, w * windowDur]);
        runStart = null;
      }
    }

    // build segments: alternating keep/cut across the full duration
    const segments = [];
    let cursor = 0;
    for (const [s, e] of silentRuns) {
      const cutStart = Math.max(cursor, s + padding);
      const cutEnd = Math.max(cutStart, e - padding);
      if (cutStart > cursor) segments.push({ start: cursor, end: cutStart, keep: true });
      if (cutEnd > cutStart) segments.push({ start: cutStart, end: cutEnd, keep: false });
      cursor = Math.max(cursor, cutEnd);
    }
    if (cursor < state.duration) segments.push({ start: cursor, end: state.duration, keep: true });

    // drop near-zero-length slivers
    state.segments = segments.filter(s => s.end - s.start > 0.05);
    state.waveform = downsampleWaveform(dbSeries, 400);
    drawSpliceRuler();
    updateTrimStats();
    audioCtx.close();
  } catch (err) {
    console.error(err);
    alert('Could not analyze audio in this file — you can still trim manually by editing captions, or just render without trimming.');
  } finally {
    els.analyzeBtn.textContent = 'Scan for silence';
    els.analyzeBtn.disabled = false;
  }
}

function downsampleWaveform(dbSeries, buckets) {
  const out = new Float32Array(buckets);
  const chunk = Math.max(1, Math.floor(dbSeries.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let max = -100;
    for (let i = b * chunk; i < Math.min(dbSeries.length, (b + 1) * chunk); i++) {
      if (dbSeries[i] > max) max = dbSeries[i];
    }
    out[b] = max;
  }
  return out;
}

function drawSpliceRuler() {
  const canvas = els.spliceCanvas;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = 72;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  // waveform background
  if (state.waveform) {
    ctx.fillStyle = '#3A3E34';
    const bw = w / state.waveform.length;
    for (let i = 0; i < state.waveform.length; i++) {
      const norm = Math.max(0, (state.waveform[i] + 60) / 60);
      const bh = Math.max(2, norm * (h - 20));
      ctx.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 1), bh);
    }
  }

  // segments overlay
  for (const seg of state.segments) {
    const x = (seg.start / state.duration) * w;
    const segW = ((seg.end - seg.start) / state.duration) * w;
    if (seg.keep) {
      ctx.fillStyle = 'rgba(107,143,113,0.35)';
      ctx.fillRect(x, 0, segW, h);
      ctx.strokeStyle = '#6B8F71';
    } else {
      ctx.fillStyle = 'rgba(193,85,59,0.5)';
      ctx.fillRect(x, 0, segW, h);
      // hatch pattern
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, 0, segW, h);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      for (let hx = x - h; hx < x + segW; hx += 6) {
        ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx + h, h); ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = '#C1553B';
    }
    ctx.lineWidth = 1;
    ctx.strokeRect(x, 0, segW, h);
  }
}

els.spliceCanvas.addEventListener('click', (e) => {
  if (!state.segments.length) return;
  const rect = els.spliceCanvas.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  const t = ratio * state.duration;
  const seg = state.segments.find(s => t >= s.start && t <= s.end);
  if (seg) { seg.keep = !seg.keep; drawSpliceRuler(); updateTrimStats(); }
});
window.addEventListener('resize', () => { if (state.waveform) drawSpliceRuler(); });

function updateTrimStats() {
  const kept = state.segments.filter(s => s.keep).reduce((a, s) => a + (s.end - s.start), 0);
  const cut = state.duration - kept;
  els.trimStats.innerHTML = `<span>kept: <b>${fmtTime(kept)}</b></span><span>cut: <b>${fmtTime(cut)}</b></span>`;
}

// ------------------------------------------------------------
// Captions
// ------------------------------------------------------------
let captionIdSeq = 1;

els.addCaptionBtn.addEventListener('click', () => {
  const t = els.previewVideo.currentTime || 0;
  state.captions.push({ id: captionIdSeq++, start: +t.toFixed(2), end: +(t + 2).toFixed(2), text: '' });
  state.captions.sort((a, b) => a.start - b.start);
  renderCaptionList();
});

function renderCaptionList() {
  els.captionList.innerHTML = '';
  if (!state.captions.length) {
    els.captionList.innerHTML = '<p class="caption-empty">No captions yet — play the video and mark lines as you go.</p>';
    return;
  }
  for (const cap of state.captions) {
    const card = document.createElement('div');
    card.className = 'caption-card';
    card.innerHTML = `
      <div class="caption-card-row">
        <input type="number" step="0.1" value="${cap.start}" data-field="start" title="start (s)">
        <input type="number" step="0.1" value="${cap.end}" data-field="end" title="end (s)">
        <button class="del-btn" title="delete">✕</button>
      </div>
      <input type="text" value="${cap.text.replace(/"/g, '&quot;')}" data-field="text" placeholder="caption text">
    `;
    card.querySelector('[data-field="start"]').addEventListener('input', (e) => cap.start = parseFloat(e.target.value));
    card.querySelector('[data-field="end"]').addEventListener('input', (e) => cap.end = parseFloat(e.target.value));
    card.querySelector('[data-field="text"]').addEventListener('input', (e) => cap.text = e.target.value);
    card.querySelector('.del-btn').addEventListener('click', () => {
      state.captions = state.captions.filter(c => c.id !== cap.id);
      renderCaptionList();
    });
    els.captionList.appendChild(card);
  }
}
renderCaptionList();

// ------------------------------------------------------------
// Time remapping: original timeline -> trimmed timeline
// ------------------------------------------------------------
function buildKeepList() {
  const keep = state.segments.filter(s => s.keep).sort((a, b) => a.start - b.start);
  // merge touching/overlapping
  const merged = [];
  for (const s of keep) {
    if (merged.length && s.start <= merged[merged.length - 1].end + 0.01) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, s.end);
    } else merged.push({ ...s });
  }
  return merged.length ? merged : [{ start: 0, end: state.duration }];
}

function mapToTrimmed(t, keepList) {
  let cumulative = 0;
  for (const seg of keepList) {
    if (t < seg.start) return cumulative; // falls in a cut before this segment -> snap forward
    if (t <= seg.end) return cumulative + (t - seg.start);
    cumulative += seg.end - seg.start;
  }
  return cumulative; // past the end
}

// ------------------------------------------------------------
// ffmpeg escaping helpers
// ------------------------------------------------------------
function escDrawtext(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\u2019")
    .replace(/%/g, '\\%');
}

// ------------------------------------------------------------
// Render pipeline
// ------------------------------------------------------------
els.renderBtn.addEventListener('click', render);

async function ensureFfmpeg() {
  if (state.ffmpegLoaded) return state.ffmpeg;
  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => {
    els.logOutput.textContent += message + '\n';
    els.logOutput.scrollTop = els.logOutput.scrollHeight;
  });
  ffmpeg.on('progress', ({ progress }) => {
    const pct = Math.min(100, Math.max(0, Math.round(progress * 100)));
    els.progressFill.style.width = pct + '%';
    els.progressLabel.textContent = `rendering… ${pct}%`;
  });
  const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd';
  els.progressLabel.textContent = 'loading engine (first time only, ~30MB)…';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });
  state.ffmpeg = ffmpeg;
  state.ffmpegLoaded = true;
  return ffmpeg;
}

async function render() {
  if (!state.file) return;
  els.renderBtn.disabled = true;
  els.renderProgress.hidden = false;
  els.progressFill.style.width = '0%';
  els.logOutput.textContent = '';
  try {
    const ffmpeg = await ensureFfmpeg();

    els.progressLabel.textContent = 'preparing files…';
    const inExt = (state.file.name.split('.').pop() || 'mp4').toLowerCase();
    const inputName = `input.${inExt}`;
    await ffmpeg.writeFile(inputName, await fetchFile(state.file));

    const fontURL = 'https://raw.githubusercontent.com/floriankarsten/space-grotesk/master/fonts/otf/SpaceGrotesk-Regular.otf';
    await ffmpeg.writeFile('font.ttf', await fetchFile(fontURL));

    const keepList = buildKeepList();
    const selectExpr = keepList.map(s => `between(t,${s.start.toFixed(3)},${s.end.toFixed(3)})`).join('+');

    // crop geometry
    const isLandscape = state.videoWidth / state.videoHeight > 9 / 16;
    let cropFilter;
    if (isLandscape) {
      const cropH = state.videoHeight;
      const cropW = Math.round(cropH * 9 / 16);
      const maxX = state.videoWidth - cropW;
      const cropX = Math.round(state.cropXRatio * maxX);
      cropFilter = `crop=${cropW}:${cropH}:${cropX}:0,`;
    } else {
      cropFilter = ''; // already portrait-ish; scale/pad below handles it
    }

    // captions -> drawtext chain, remapped to trimmed timeline
    let drawtextChain = '';
    for (const cap of state.captions) {
      if (!cap.text.trim()) continue;
      const ms = mapToTrimmed(cap.start, keepList);
      const me = mapToTrimmed(cap.end, keepList);
      if (me <= ms) continue;
      const safeText = escDrawtext(cap.text.trim());
      drawtextChain += `,drawtext=fontfile=font.ttf:text='${safeText}':fontsize=58:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h-280:enable='between(t,${ms.toFixed(3)},${me.toFixed(3)})'`;
    }

    const filterComplex =
      `[0:v]select='${selectExpr}',setpts=N/FRAME_RATE/TB,${cropFilter}scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black${drawtextChain}[v];` +
      `[0:a]aselect='${selectExpr}',asetpts=N/SR/TB[a]`;

    els.progressLabel.textContent = 'rendering…';
    await ffmpeg.exec([
      '-i', inputName,
      '-filter_complex', filterComplex,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      'output.mp4',
    ]);

    const data = await ffmpeg.readFile('output.mp4');
    const blob = new Blob([data.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    els.resultVideo.src = url;
    els.downloadLink.href = url;
    showStage('result');
  } catch (err) {
    console.error(err);
    els.logOutput.textContent += `\nERROR: ${err.message || err}\n`;
    alert(`Render failed: ${err.message || err}\n\nCheck the engine log panel for the full detail.`);
  } finally {
    els.renderBtn.disabled = false;
    els.renderProgress.hidden = true;
  }
}

els.startOverBtn.addEventListener('click', () => {
  state.file = null;
  state.segments = [];
  state.captions = [];
  els.fileInput.value = '';
  renderCaptionList();
  showStage('upload');
});
