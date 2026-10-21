# Demo video pipeline: design

Status: approved 2026-10-21. Size L, high risk (new cross-module contract, API spend, pre-1.0 renderer).

## Goal

Take a silent product screen recording (`projects/<name>/input.mp4`) and produce a finished demo video:

- intro, chapter, and outro cards with animated transitions
- ElevenLabs voiceover
- subtitles burned in, plus `.srt` and `.vtt` sidecars
- walkthrough animation over the real recording: camera zoom/pan to regions, click rings, callout boxes/arrows/labels

Claude Opus 5.5 is the director. It reads sampled frames and writes `edit-plan.json`. Everything after the plan is deterministic code.

## Decisions

- Renderer: HyperFrames (`hyperframes@0.8.183`, Apache-2.0). HTML + GSAP compositions rendered to MP4 by headless Chrome and ffmpeg.
- Director: both front ends write the same `edit-plan.json`.
  - `/demo-video` project skill: the Claude Code session looks at frames, writes the plan, and iterates with the user.
  - `npm run plan`: the same over the Anthropic API for unattended runs.
- Output 1920x1080 at 30 fps. Captions burned in by default (`style.captions.mode: "off"` disables).
- Music: none, a user file, or ElevenLabs `music.compose` from `audio.music.prompt`. SFX via ElevenLabs sound effects.
- Plan script effort default `high` (`DEMO_EFFORT`), model `claude-opus-5-5` (`DEMO_MODEL`).

## Facts the design depends on

Claude API (`@anthropic-ai/sdk@0.137.0`)
- No video input. Send JPEG frames. Up to 600 images per request; when more than 20, each must be at most 2000 px per side. Tokens per image about ceil(w/28) * ceil(h/28).
- Opus 5.5 thinking cannot be disabled; control depth with `output_config.effort`. Forced `tool_choice` (`any`/`tool`) returns 400.
- Structured output: `zodOutputFormat(schema)` from `@anthropic-ai/sdk/helpers/zod` in `output_config.format`. Long outputs must stream: `client.messages.stream(...).finalMessage()`, then parse the text with the same Zod schema.
- Server-side refusal fallback: `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"` (may require `client.beta.messages.stream`). Check `stop_reason` before reading content; `"refusal"` is an error with `stop_details`.
- Vision bounding boxes are approximate. Clamp and smooth in code.

ElevenLabs (`@elevenlabs/elevenlabs-js@2.74.0`)
- `client.textToSpeech.convertWithTimestamps(voiceId, { text, modelId, previousText, nextText, voiceSettings?, outputFormat?, seed? })` returns `{ audioBase64, alignment?, normalizedAlignment? }`. Each alignment has `characters[]`, `characterStartTimesSeconds[]`, `characterEndTimesSeconds[]`.
- Fallback when `alignment` is absent: `client.forcedAlignment.create({ file, text })` returns `words[{ text, start, end, loss }]`.
- `client.textToSoundEffects.convert({ text, durationSeconds, promptInfluence?, loop? })`, max 30 s.
- `client.music.compose(...)`, paid plans only.
- Whether `eleven_v4` supports with-timestamps is unverified; the code must handle a missing `alignment`.

HyperFrames 0.8.183 (verify during the spike; `docs/spike.md` records results)
- Node >= 22. `npx hyperframes browser ensure` downloads a pinned chrome-headless-shell to `~/.cache/hyperframes/chrome`; `HYPERFRAMES_BROWSER_PATH` overrides.
- Root element: `data-composition-id`, `data-start="0"`, `data-width`, `data-height`, `data-duration` (compile-time), optional `data-fps`.
- Timed elements: `id` + `class="clip"` + `data-start` + `data-duration`.
- `<video id src data-start data-duration data-media-start data-playback-rate muted playsinline>`. Front trim is `data-media-start`. Frames are extracted by ffmpeg.
- `<audio id src data-start data-duration data-media-start data-volume>`; volume automation through `data-automation`.
- One paused GSAP timeline per composition registered at `window.__timelines[<composition id>]`; `data-no-timeline` for static compositions. Never animate a `<video>` box directly; animate a wrapper.
- Nested compositions: host `<div data-composition-id data-composition-src="compositions/x.html" data-start data-duration>`; the file wraps content in `<template>`. Generate one file per card.
- Render: `npx hyperframes render <dir> --output <file> --fps 30 --quality draft|looks|standard|high --video-frame-format png --workers 1 --json`. Use `--workers 1` on macOS (multi-worker capture spills raw frames to disk).
- `npx hyperframes lint <dir> --strict`, `doctor --json`, `snapshot --at 0,2,5`.
- Spawn env: `HYPERFRAMES_NO_UPDATE_CHECK=1`, `HYPERFRAMES_SKIP_SKILLS=1`.
- Catalog `cursor-zoom-follow` is screenshot-only; we build our own camera. `cursor-annotate` (Apache-2.0) may be vendored with its licence header.

Machine: node 26.7, ffmpeg/ffprobe 8.1.2, no Google Chrome, python 3.9. npm 11 `allowScripts` skips package install scripts unless approved.

## Project layout on disk

```
projects/<name>/
  input.mp4            user upload (gitignored)
  brief.md             optional: audience, tone, target length, must-say lines
  edit-plan.json       the contract (committed)
  music/               optional licensed bed
  build/               derived, gitignored
    probe.json scenes.json motion.json
    frames/NNNN.jpg    1 fps, 1280 wide
    sheets/NN.jpg      3x3 contact sheets, 1920x1080, timestamp per tile
    contact.jpg
    cache/plan/<sha>.json  cache/voice/<sha>.mp3 + <sha>.align.json  cache/sfx/<sha>.mp3  cache/music/<sha>.mp3
    voice.json timeline.json captions.srt captions.vtt
    hf/                index.html, hyperframes.json, compositions/cards/*.html, assets/
    render.mp4
    <stage>.hash       input hash of the last successful run of that stage
  out/                 gitignored
    final.mp4 final.srt final.vtt contact.jpg
```

## Stages

Each stage is a thin CLI in `src/cli/<stage>.ts` over pure, tested modules. Every stage reads from disk, writes atomically (`.part` then rename), and records its input hash.

1. probe (`src/probe/`)
   - `ffprobe.ts`: width, height, fps, duration → `probe.json`.
   - `scenes.ts`: run `ffmpeg -i input -vf "select='gt(scene,0.12)',showinfo" -f null -`, parse `pts_time` from stderr → `scenes.json` `[{ t, score }]`.
   - `motion.ts`: decode at 1 fps, 320x180 gray rawvideo; diff consecutive frames; per-second bounding box of changed pixels scaled to source pixels; idle spans → `motion.json`.
   - `frames.ts`: 1 fps JPEG frames 1280 wide; 3x3 contact sheets with the timestamp drawn on each tile (ffmpeg `drawtext` + `tile`); a single `contact.jpg` overview.
2. plan (`src/director/`)
   - `DIRECTOR.md`: the shared director brief. Camera grammar (push in to the region being used, hold, pull back to full frame between areas; one idea per shot), pacing, narration style (plain, second person, no invented features or numbers), caption rules, coordinate rules (boxes in source pixels of `probe.json` dimensions; sheet tiles are scaled, so convert), and how to choose `fit`.
   - `images.ts`: load sheets as base64 image blocks, each labelled with its time range.
   - `prompt.ts`: deterministic request builder (system = DIRECTOR.md, user = probe summary + scenes + motion + brief + sheets). Same inputs give byte-identical requests.
   - `plan.ts`: `makePlan(client, inputs)` streams `DEMO_MODEL` with `output_config: { effort, format: zodOutputFormat(EditPlanDraft) }`, checks `stop_reason === "end_turn"`, parses, fills `meta.source` from probe, runs `validatePlan`. Cached at `build/cache/plan/<sha>.json` keyed on DIRECTOR.md, schema JSON, sheet hashes, brief, model, effort. The Anthropic client is injected so tests use a fake.
   - `--from-narration narration.txt`: skeleton plan, one scene per `# m:ss` block.
   - The `/demo-video` skill uses the same DIRECTOR.md and schema, writes the JSON itself, and runs `npm run plan:check`.
3. voice (`src/voice/`)
   - `elevenlabs.ts`: wraps `convertWithTimestamps`, `forcedAlignment.create`, `textToSoundEffects.convert`, `music.compose` behind a small interface so tests inject fakes.
   - `cache.ts`: `writeCached(dir, key, produce)`; `.part` then rename; never leaves `.part` on failure.
   - `align.ts`: character alignment → words `[{ text, start, end }]`; prefers `alignment` over `normalizedAlignment` when both exist.
   - `clips.ts`: moved from the root; `splitSegments` returns `{ text, at? }`, parsing `# m:ss` comment lines into `at`.
   - Per narration line: cache key sha256(voiceId, modelId, text, previousText, nextText, voiceSettings, outputFormat). If `alignment` is missing, call forced alignment on the audio.
   - Output `voice.json`: `{ lines: { [lineId]: { file, duration, words[] } }, sfx: {...}, music?: {...} }`. Duration from ffprobe on the MP3.
   - `--dry-run` prints each line with character counts and totals and calls nothing. `--audition "<text>" --voices a,b` renders short clips into `build/audition/`.
4. timeline (`src/timeline/`, pure; no I/O)
   - Inputs: plan, probe, voice. Output `timeline.json` with absolute output times for every element.
   - Order: intro card, then per chapter (chapter card if any, scenes), then outro card. Transitions overlap neighbours by `transition.sec` for `dissolve`; `fade-black` inserts half-fade out and in; `cut` is zero.
   - Per scene, V = sum(line duration + pauseAfter) + 0.2 s lead-in; S = source.out - source.in.
     - V <= S: play at rate 1 for S (`hold`), or cut the tail to V + 0.8 s (`trim`).
     - V > S, `freeze` (default): play S, then hold a still of the last frame for V - S + 0.6 s. Warn above 6 s.
     - V > S, `slow`: rate = max(0.5, S / V); any remainder becomes a freeze.
     - Narration line `at` (source time) is a lower bound for the line start; lines never overlap.
   - Camera (`camera.ts`): stage is 1920x1080; source is fit with letterbox (`sourceToStage`). Each keyframe box is expanded to at least 10% of the frame, to 16:9, and clamped inside the frame. scale = clamp(min(W / w, H / h), 1, style.camera.maxZoom); translate so the box centre sits at stage centre, clamped so no letterbox gap opens. `transform-origin: 0 0`. Moves last `style.camera.moveSec` with `power2.inOut`. `box: null` returns to full frame. Source times map through rate changes and freezes.
   - Clicks and callouts map the same way; callout labels are placed on `side` (auto picks the side with most room).
   - Captions (`captions.ts`): words → cues. At most 42 characters per line, 2 lines, 20 characters per second. Split at sentence ends first, then commas, then before conjunctions/prepositions. Hold each cue at least max(1.8 s, speech + 0.6 s), clipped to the next cue start. Emits SRT and VTT text.
   - Ducking (`ducking.ts`): music volume lane points. Explicit point at t=0 at `gainDb`; duck to `gainDb + duckDb` during narration windows with 0.3 s ramps.
5. compose (`src/compose/`)
   - Pure function `compose(timeline, plan, assets)` returns `{ files: { [relPath]: string | { copyFrom } } }`; the CLI writes them to `build/hf/`.
   - Root `index.html`: `data-composition-id="demo"`, `data-duration = timeline.total`, 1920x1080, 30 fps.
   - Layers bottom to top: background; camera wrapper `.cam` (untimed div with the transform) containing one `<video>` per scene segment (`muted playsinline`, `data-media-start`, `data-playback-rate`) and freeze `<img class="clip">` stills; overlay layer inside the camera (click rings, callout boxes/arrows/labels, so they track the UI under zoom); cards as nested compositions `compositions/cards/<id>.html`; captions as static `<div class="cap clip">` elements; `<audio>` per narration line, SFX, music with its volume lane.
   - One GSAP timeline at `window.__timelines["demo"]` for camera moves, click rings, callouts, card motion, and transitions.
   - Transitions v1: `cut`, `fade-black`, `dissolve`. `push` falls back to `dissolve` with a warning until implemented.
   - Assets: hardlink or copy `input.mp4`, freeze PNGs, voice/SFX/music audio; vendor `gsap.min.js` from the `gsap` package and Inter woff2 from `@fontsource/inter` into `assets/` so rendering needs no network.
   - Theme: `style.theme`, `style.accent`, `style.font` drive CSS variables. Cards: big title, subtitle, accent bar; enter and exit with a short slide and fade.
6. render (`src/render/render.ts`): `npx hyperframes lint build/hf --strict`, then `npx hyperframes render build/hf --output build/render.mp4 --fps 30 --quality <looks|draft> --video-frame-format png --workers 1 --json`, with the HyperFrames env flags. Arguments passed as an array, never through a shell.
7. mux (`src/render/mux.ts`, `contact.ts`): two-pass `loudnorm` to -14 LUFS / -1.5 dBTP with `-c:v copy` and `-map_metadata -1` → `out/final.mp4`; copy captions to `out/final.srt` and `out/final.vtt`; contact sheet `out/contact.jpg` via `fps=1/5,scale=320:-1,tile=6x5`.
8. demo (`src/cli/demo.ts`): runs probe → plan (only if `edit-plan.json` is missing and `--plan` is given) → plan:check → voice → timeline → compose → render → mux, skipping stages whose `build/<stage>.hash` matches. `--force` reruns all; `--draft` renders draft quality. Spending stages print what they will spend and require `--yes` when not cached.

## edit-plan.json schema (`src/schema/edit-plan.ts`, Zod 4)

```ts
const sec = z.number().min(0);
const px = z.number().int().min(0);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Box = z.object({ x: px, y: px, w: px.min(1), h: px.min(1) }); // source pixels

const Line = z.object({
  id: slug,
  text: z.string().min(1).max(600),
  at: sec.optional(),            // source time, lower bound for the line start
  pauseAfter: sec.default(0.35),
});

const Card = z.object({
  kind: z.enum(["title", "chapter", "outro"]),
  title: z.string().min(1).max(60),
  subtitle: z.string().max(90).optional(),
  sec: sec.default(3),
  narration: z.array(Line).default([]),
});

const Scene = z.object({
  id: slug,
  source: z.object({ in: sec, out: sec }),
  fit: z.enum(["hold", "freeze", "slow", "trim"]).default("freeze"),
  narration: z.array(Line),
  camera: z.array(z.object({ t: sec, box: Box.nullable() })).default([]),
  clicks: z.array(z.object({ t: sec, x: px, y: px, kind: z.enum(["click", "double", "drag"]).default("click") })).default([]),
  callouts: z.array(z.object({
    t0: sec, t1: sec, box: Box, label: z.string().min(1).max(40),
    kind: z.enum(["box", "arrow", "annotate"]).default("box"),
    side: z.enum(["auto", "top", "bottom", "left", "right"]).default("auto"),
  })).default([]),
});

const Chapter = z.object({
  id: slug,
  title: z.string().min(1).max(60),
  card: Card.optional(),
  scenes: z.array(Scene).min(1),
  transition: z.object({ kind: z.enum(["cut", "fade-black", "dissolve", "push"]), sec: sec.default(0.5) }).default({ kind: "cut", sec: 0 }),
});

export const EditPlan = z.object({
  version: z.literal(1),
  meta: z.object({
    project: slug,
    title: z.string().min(1),
    source: z.object({ width: px, height: px, fps: z.number().positive(), duration: sec }),
    output: z.object({ width: z.literal(1920), height: z.literal(1080), fps: z.literal(30) }),
  }),
  style: z.object({
    theme: z.enum(["light", "dark"]).default("dark"),
    accent: hex.default("#6E56CF"),
    font: z.string().default("Inter"),
    captions: z.object({ mode: z.enum(["burn-in", "off"]).default("burn-in"), maxCharsPerLine: z.literal(42).default(42), maxLines: z.literal(2).default(2) }),
    camera: z.object({ maxZoom: z.number().min(1).max(3).default(2.4), moveSec: sec.default(0.7) }),
  }),
  intro: Card.optional(),
  outro: Card.optional(),
  chapters: z.array(Chapter).min(1),
  audio: z.object({
    voice: z.object({ voiceId: z.string().min(1), modelId: z.string().min(1) }),
    music: z.object({ file: z.string().nullable().default(null), prompt: z.string().max(400).optional(), gainDb: z.number().default(-18), duckDb: z.number().default(-12) }),
    sfx: z.array(z.object({ scene: slug, t: sec, prompt: z.string().min(1).max(200), sec: sec.max(30) })).default([]),
  }),
});

// What the director writes: meta.source is filled from probe.json afterwards.
export const EditPlanDraft = EditPlan.extend({ meta: EditPlan.shape.meta.omit({ source: true }) });
```

Field details may be adjusted by the foundation track if Zod 4 or `zodOutputFormat` require it (for example, structured outputs may not accept `.default()` or regex patterns; then the draft schema drops them and defaults are applied after parsing). Any change is recorded in this section.

`validatePlan(plan, probe)` returns `{ errors[], warnings[] }`:
- errors: `source.in < source.out <= probe.duration`; every scene-relative `t`, `at`, `t0`, `t1` inside its scene window; scenes ascending and non-overlapping in source time; ids unique; `t0 < t1`; sfx `scene` refers to an existing scene; boxes intersect the frame.
- warnings: boxes clamped; callout window overlapping a camera move; estimated narration much longer than the scene (characters / 15 per second > S + 6 s); more than 3 callouts visible at once.

`edit-plan.schema.json` is generated from `EditPlan` with `z.toJSONSchema` by `npm run schema` and committed.

## Repo layout

```
src/schema/    edit-plan.ts validate.ts edit-plan.schema.json
src/probe/     ffprobe.ts scenes.ts motion.ts frames.ts
src/director/  DIRECTOR.md images.ts prompt.ts plan.ts
src/voice/     clips.ts elevenlabs.ts cache.ts align.ts
src/timeline/  types.ts timeline.ts camera.ts captions.ts ducking.ts
src/compose/   compose.ts templates/*.ts vendor.ts
src/render/    render.ts mux.ts contact.ts
src/cli/       probe plan plan-check voice compose render mux demo schema clean (.ts)
src/util/      hash.ts fs.ts exec.ts
test/fixtures/ edit-plan.json probe.json voice.json timeline.json expected-index.html spike/
test/smoke.test.ts
```

Tests sit next to their module as `*.test.ts`, use `node:test` with hand-written fakes and `mkdtemp` temp dirs, and never touch the network.

Config:
- tsconfig `include: ["src/**/*.ts", "test/**/*.ts"]`; `@types/node ^22`.
- Exact pins: `@anthropic-ai/sdk 0.137.0`, `@elevenlabs/elevenlabs-js 2.74.0`, `zod 4.6.7`, `gsap 3.15.0`, `@fontsource/inter` (current), dev `hyperframes 0.8.183`.
- Scripts: `probe plan plan:check voice compose render mux demo schema clean hf typecheck test test:smoke check`. `check` = typecheck + unit tests + smoke.
- Env: `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`, `ANTHROPIC_API_KEY`, `DEMO_MODEL`, `DEMO_EFFORT`, optional `HYPERFRAMES_BROWSER_PATH`. Scripts that call APIs load `.env.local` via `tsx --env-file-if-exists=.env.local` (or `--env-file` if the flag is unavailable).

## Claude Code setup (project scope)

- HyperFrames plugin pinned to the CLI version: `claude plugin marketplace add heygen-com/hyperframes#v0.8.183`, then `claude plugin install hyperframes@hyperframes --scope project`.
- ElevenLabs skills via `npx skills add elevenlabs/skills`: `text-to-speech`, `sound-effects`, `music`, `speech-to-text`. The existing `agents` skill stays.
- `.mcp.json`: ElevenLabs hosted MCP (`https://api.elevenlabs.io/v1/mcp`, OAuth). Optional, for browsing voices interactively. The pipeline uses the SDK.
- `.claude/settings.json`: deny `Read(./.env)` and `Read(./.env.*)`; allow `Bash(npm run *)`, `Bash(npx hyperframes *)`, `Bash(ffmpeg *)`, `Bash(ffprobe *)`; env `HYPERFRAMES_NO_UPDATE_CHECK=1`, `HYPERFRAMES_SKIP_SKILLS=1`.
- `.claude/skills/demo-video/SKILL.md` gated flow:
  0. Confirm `projects/<name>/input.mp4`, read `brief.md`, one question round (audience, tone, target length, voice, music). Say that frames are sent to Anthropic.
  1. `npm run probe -- <name>`; read `contact.jpg`, `scenes.json`, `motion.json`, sheets.
  2. Write `edit-plan.json` following `src/director/DIRECTOR.md` and the schema; `npm run plan:check -- <name>`. Gate: zero errors and the user approves a chapter/scene table with durations.
  3. `npm run voice -- <name> --dry-run`. Gate: the user approves the spend. Then `npm run voice -- <name> --yes`.
  4. `npm run compose`, `npm run render -- <name> --draft`, `npm run mux`; show `out/contact.jpg`. Iterate by editing `edit-plan.json` only.
  5. Final render at `looks` quality.
- Project `CLAUDE.md`, at most 25 lines.

## Testing

THE CHECK: `npm run check`.

Unit tests (no network): schema fixture passes, one failing case per `validatePlan` rule; `align` (spaces, punctuation, both alignments); `captions` (line length, line count, cps, hold, SRT/VTT format); `timeline` (hold, trim, freeze, slow, `at` lower bound, transitions, source-to-output mapping); `camera` (box to transform, clamps, letterbox); `ducking`; `compose` (golden `test/fixtures/expected-index.html`, refreshed with `UPDATE_GOLDEN=1`, plus structural checks); `prompt` determinism; `cache` atomicity; `clips` (existing cases plus `at`); `scenes` stderr parsing; `motion` bounding boxes from a synthetic buffer; `plan` with a fake client returning the fixture.

Smoke test (`test/smoke.test.ts`, no API keys): skips with a reason when ffmpeg or the HyperFrames browser is unavailable.
1. `ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30:duration=8` → `input.mp4` in a `mkdtemp` project.
2. Copy `test/fixtures/edit-plan.json` (intro card, one chapter card, two scenes, one zoom, one click, one callout, outro).
3. Fake voice: `sine=frequency=440` MP3s sized to each line, alignment spread evenly over the words.
4. Run timeline → compose → render (`--quality draft`) → mux.
5. Assert with ffprobe: duration within 0.1 s of `timeline.total`; one h264 1920x1080 stream and one aac stream; SRT cue count equals the timeline's; VTT starts with `WEBVTT`; frames at intro, mid-scene, and outro are not black.

## Risks

- HyperFrames churn: pre-1.0 with frequent releases. Pin the exact version and the marketplace tag; disable auto-update; upgrades are deliberate and gated by the smoke test.
- The schema is a contract between the skill, the API script, and the renderer. It carries `version: 1`.
- Spend: Claude vision on sheets and ElevenLabs per character. Hash caches and dry-run gates; nothing spends without an explicit yes.
- Privacy: recordings go to Anthropic as images.
- Licences: GSAP no-charge licence (not OSI; vendored only into the ignored build dir); Inter is OFL; avoid catalog blocks with unconfirmed textures and anything that loads fonts from the network at render time; music and SFX rights depend on the ElevenLabs plan.
- Disk: `--workers 1` by default.

## Fallback if the spike fails

If HyperFrames cannot embed the recording frame-accurately, the schema and timeline stay as designed. Compose emits transparent overlays (cards, captions, callouts) rendered by HyperFrames; render does camera crop/scale and compositing in ffmpeg. Only the compose/render track changes, and the user re-confirms first.
