# Clipbench

A free, self-hosted alternative to the "raw footage → vertical short clip" part of
tools like Reelsmith and Clipzi. It's a **static website** — three files, no backend,
no database, no per-user cost to you. All video processing happens in the visitor's
own browser via [ffmpeg.wasm](https://ffmpegwasm.netlify.app/), so nothing they
upload ever touches a server.

## What it does

- **Trims dead air** — analyzes the audio track in-browser (Web Audio API), finds
  quiet stretches below a threshold, and lets the visitor click regions on a splice
  ruler to keep or cut them before rendering.
- **Crops to 9:16** — draggable crop window over a landscape source, rendered at
  1080×1920.
- **Burns in captions** — a manual/assisted caption editor (play the video, tap
  "mark caption at current time", type the line, adjust in/out points). No AI
  transcription — see "What it doesn't do" below.
- Renders everything with one `ffmpeg` filtergraph and offers the result as a
  downloadable `.mp4`.

## What it doesn't do (on purpose, and why)

Reelsmith/Clipzi run hosted AI models — speech-to-text, a vision model that reads
frames to pick crops, an LLM that finds "the hook," multi-take generation, GPU
rendering at scale. That requires paid infrastructure (GPU time, model API calls,
storage, render queues). None of that can run for free in a browser tab, so this
tool intentionally does the mechanical parts (trim, crop, caption burn-in) well
and leaves the "AI judgment" parts to a human — you scrub the timeline and mark
the hook yourself, which takes a couple of minutes per clip.

If you later want real auto-transcription, the cleanest upgrade path is to keep
this front end and add one server call to a speech-to-text API (e.g. Whisper via
a hosted endpoint) to pre-fill the caption list — everything else (crop, trim,
burn-in) stays client-side.

## Hosting it (all free tiers)

It's static files, so any of these work — pick whichever you already use:

**Netlify / Vercel (drag-and-drop)**
1. Go to app.netlify.com (or vercel.com) → new site → drag this folder in.
2. Done — you get a URL immediately, free tier is plenty for a static site.

**GitHub Pages**
```bash
git init
git add .
git commit -m "clipbench"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
# then in GitHub: Settings → Pages → deploy from main branch
```

**Any other static host** (S3+CloudFront, Cloudflare Pages, Firebase Hosting, etc.)
just upload `index.html`, `style.css`, and `app.js` — no build step, no server
config, no CORS headers required (this uses ffmpeg.wasm's single-threaded core
specifically so it doesn't need cross-origin-isolation headers).

## Local testing

Because it loads modules and fonts, open it through a local server rather than
`file://`:
```bash
npx serve .
# or
python3 -m http.server 8000
```

## Notes / known limits

- First render in a session downloads the ffmpeg engine (~30MB); the browser
  caches it, so repeat visits are fast.
- Silence detection quality depends on the threshold/gap sliders — noisy
  recordings need a lower (more negative) threshold.
- Crop assumes a single fixed horizontal position per render — there's no
  per-frame face tracking (that's the part that needs a vision model).
- Very long source videos will be slow, since everything runs on the visitor's
  CPU. This is best suited to clips under ~10–15 minutes.
- Tested against the standard MP4/H.264 case. Some exotic codecs/containers
  may need `ffmpeg`'s broader codec support that isn't included in the
  lightweight wasm core.
