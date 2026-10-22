# demo-voiceover

Turns a silent screen recording into a narrated demo video. Claude looks at sampled frames and writes
an edit plan. ElevenLabs voices the narration. HyperFrames renders the result at 1920x1080, 30 fps,
with title and chapter cards, camera zooms, click rings, callouts, and burned-in captions.

Output, in `projects/<name>/out/`:

- `final.mp4`, the finished video
- `final.srt` and `final.vtt`, caption sidecars
- `contact.jpg`, a contact sheet for a quick look

## Requirements

- Node 22 or newer (tested on 26)
- `ffmpeg` and `ffprobe` on your PATH
- `npm ci`
- `npx hyperframes browser ensure`, which downloads its own headless Chrome. You do not need Google Chrome.

npm 11 may skip esbuild's install script. `tsx` still works without it.

Put your keys in `.env.local`. Scripts that call an API load it themselves.

| Variable | Use |
|---|---|
| `ANTHROPIC_API_KEY` | The API director (`npm run plan`). An `ant auth login` profile also works. |
| `ELEVENLABS_API_KEY` | Voice, sound effects, music |
| `ELEVENLABS_VOICE_ID` | Optional. Used when the plan's `voiceId` is `default`. |
| `ELEVENLABS_MODEL_ID` | Optional. Used when the plan's `modelId` is `default`. Falls back to `eleven_v4`. |
| `DEMO_MODEL` | Optional. Director model, default `claude-opus-5-5`. |
| `DEMO_EFFORT` | Optional. Director effort, default `high`. |

## Quick start

1. Copy your recording to `projects/<name>/input.mp4`. Add `projects/<name>/brief.md` if you want to
   give the director an audience, a tone, a target length, or lines it must say.
2. Drive the pipeline with one of the two routes below.

Screen captures often have a variable frame rate. If `probe` warns about it, re-encode first:

```
ffmpeg -i in.mov -vf fps=30 -c:v libx264 -crf 16 input.mp4
```

## Two ways to drive it

In Claude Code, run `/demo-video`. Claude reads the frames, writes `edit-plan.json`, and shows you a
table of chapters and scenes. It asks before every step that spends money.

For an unattended run, use the API director:

```
npm run demo -- <name> --plan --yes
```

One `--yes` approves both the Anthropic director and the ElevenLabs voice spend. Without `--yes`,
the command stops and prints what it would spend. You can also run the stages one at a time.

## Stages

Run each as `npm run <stage> -- <name> [flags]`. Keep the `--` right after the stage name, because the
permission rules in `.claude/settings.json` match that form.

| Stage | What it does | Flags |
|---|---|---|
| `probe` | Samples frames, finds cuts and motion, builds contact sheets in `build/` | `--force` |
| `plan` | The API director writes `edit-plan.json`. Prints a cost estimate without `--yes`. | `--yes`, `--force`, `--from-narration <file>` |
| `plan:check` | Validates the plan and prints a chapter and scene table | |
| `voice` | Generates narration, sound effects, and music, with timestamps | `--dry-run`, `--yes`, `--audition "<text>" --voices a,b` |
| `timeline` | Builds `build/timeline.json` and the captions | |
| `compose` | Writes the HyperFrames project in `build/hf/` | |
| `render` | Renders `build/render.mp4` | `--draft` |
| `mux` | Adds audio and writes `out/` | |
| `demo` | Runs the chain and skips stages whose inputs have not changed | `--plan`, `--yes`, `--draft`, `--force` |
| `clean` | Removes `build/hf`, the render, and stage hashes | `--all`, `--cache` |
| `schema` | Regenerates `src/schema/edit-plan.schema.json` | |

`plan` and `voice` exit with code 3 when they stop before spending. `demo` stops there too until you
pass `--yes`. `plan` will not overwrite an existing plan without `--force`.

`--from-narration narration.txt` seeds a plan from a text file, one scene per block, with no API call.
A `# m:ss` line before a block sets where that scene starts in the recording. The repo's
`narration.txt` shows the format.

`clean --all` removes `out/` and `build/` but keeps `build/cache`. Add `--cache` to delete that too.

## edit-plan.json

`projects/<name>/edit-plan.json` is the contract between the director and everything after it. It is
the only file you edit by hand. Never edit `build/` or `out/`.

The schema lives in `src/schema/edit-plan.ts`, with a JSON Schema copy in
`src/schema/edit-plan.schema.json`. `test/fixtures/edit-plan.json` is a complete example. The main knobs:

- Chapters hold scenes. Each scene has a source span (`in` and `out`, in seconds), a `fit` mode
  (`hold`, `freeze`, `slow`, or `trim`) that says what to do when narration and footage differ in length,
  and its narration lines.
- Camera moves are boxes in source pixels, set per time. Clicks are points with a time.
  Callouts are a box, a label, and a time span.
- Intro, chapter, and outro cards have a title, a subtitle, and a length. Chapters set a transition:
  `cut`, `fade-black`, `dissolve`, or `push`.
- `style` sets the theme (`light` or `dark`), the accent colour, and captions (`burn-in` or `off`).
- `audio` sets the voice and model, a music file or a music prompt, and sound effect cues.
  A music file is a bare filename inside `projects/<name>/music/`.

`src/director/DIRECTOR.md` is the brief the director follows when it writes a plan.

## Costs and privacy

`plan` sends contact sheets of your recording to Claude Opus 5.5 over the Anthropic API. Check the
recording for private content first. On the `/demo-video` route, Claude
reads the frames in your Claude Code session instead. ElevenLabs only receives text, never video.

`voice` spends ElevenLabs characters for narration, sound effects, and music. Music needs a paid plan.

Paid results are cached under `projects/<name>/build/cache`. Rerunning with unchanged inputs costs
nothing, and editing a plan re-spends only for the lines that changed. `clean --all` keeps the cache.

## Claude Code setup

This repo configures Claude Code at project scope. Trust the folder to enable it.

- The HyperFrames plugin, pinned to v0.8.183 in `.claude/settings.json`
- ElevenLabs skills in `.claude/skills/`: `text-to-speech`, `sound-effects`, `music`,
  `speech-to-text`, plus the existing `agents` skill
- The `demo-video` skill, which holds the gated flow
- An optional hosted ElevenLabs MCP server in `.mcp.json`. It uses OAuth and helps you browse voices.
  The pipeline itself uses the SDK.
- Permission rules. The stages that cannot spend (`probe`, `plan:check`, `timeline`, `compose`, `render`,
  `mux`, and the check commands) run without a prompt. `plan`, `voice`, and `demo` always ask.
  Reads of `.env` files are denied.

## Development

```
npm run check
```

This runs the typecheck, the unit tests, and an offline smoke render. It needs no keys and no network.

Source layout:

- `src/schema/` holds the plan schema and validation.
- `src/probe/` holds frame sampling, scene and motion detection.
- `src/director/` holds the director prompt and the API call.
- `src/voice/` holds ElevenLabs calls, caching, and alignment.
- `src/timeline/` maps the plan to output time, camera moves, captions, and ducking.
- `src/compose/` writes the HyperFrames project.
- `src/render/` renders, muxes, and builds the contact sheet.
- `src/cli/` holds one entry point per stage.

`docs/spike.md` records how HyperFrames was tested. The design is in
`docs/superpowers/specs/2026-10-21-demo-video-pipeline-design.md`.

HyperFrames is pinned at 0.8.183, in both `package.json` and the plugin tag. Upgrade the two together,
and only after `npm run check` passes.

## Licences

GSAP is used under its standard no-charge licence. It is copied into the ignored `build/` directory at
render time and is not committed. Inter is under the SIL Open Font Licence. Your rights to ElevenLabs
output depend on your ElevenLabs plan.
