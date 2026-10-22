# demo-voiceover

Turns a silent screen recording (`projects/<name>/input.mp4`) into a narrated demo video: Claude
writes an edit plan from sampled frames, ElevenLabs voices it, HyperFrames renders it.

## Stages

Run each as `npm run <stage> -- <name>`, with `--` right after the stage name (the permission rules
in `.claude/settings.json` match that form): probe, plan, plan:check, voice, timeline, compose,
render, mux, demo, clean.

- `demo` runs the chain and skips stages whose inputs are unchanged. `plan` and `voice` exit 3 when
  they stop short of spending; `demo` stops there until it gets `--yes`, and one
  `demo --plan --yes` approves both the director (Anthropic) and voice (ElevenLabs) spend.
- `clean --all` wipes out/ and build/ but keeps build/cache unless `--cache`.
- `/demo-video` is the interactive front end; `npm run plan` is the API one.

## Rules

- `projects/<name>/edit-plan.json` is the contract (`src/schema/edit-plan.ts`) and the only file
  edited by hand. Never edit `build/` or `out/`.
- HyperFrames is pinned (`hyperframes@0.8.183`, plugin tag `v0.8.183`); upgrades go through smoke.
- Planning over the API sends recording frames to Anthropic; check them for private content first.
- Spending (`plan --yes`, `voice --yes`) needs an explicit yes. Secrets live in `.env.local`; never
  read or print them. Check: `npm run check` (typecheck, tests, smoke; no network or keys).
