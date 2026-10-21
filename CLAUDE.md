# demo-voiceover

Turns a silent screen recording (`projects/<name>/input.mp4`) into a narrated demo video: Claude
writes an edit plan from sampled frames, ElevenLabs voices it, HyperFrames renders it.

## Stages

Each stage is `npm run <stage> -- <name>`, with `--` right after the stage name (the permission
rules in `.claude/settings.json` match that form). Stages: probe, plan, plan:check, voice, timeline,
compose, render, mux, demo.

- `demo` runs the whole chain, skipping stages whose input hash is unchanged. `plan` and `voice`
  exit 3 when they stopped short of spending; `demo` stops there until it gets `--yes`.
- `clean`: `--all` wipes out/ and build/ but keeps build/cache unless `--cache`.
- `/demo-video` is the interactive front end; `npm run plan` is the API one.

## Rules

- `projects/<name>/edit-plan.json` is the contract (`src/schema/edit-plan.ts`) and the only file you
  edit by hand. Never edit `build/` or `out/`.
- HyperFrames is pinned (`hyperframes@0.8.183`, plugin tag `v0.8.183`). Do not upgrade it casually;
  upgrades go through `npm run test:smoke`.
- Frames of the recording go to the Anthropic API when planning over the API. Check the recording
  for private content first.
- Anything that spends credits (`plan --yes`, `voice --yes`) needs an explicit yes from the user.
- Secrets live in `.env.local`; never read or print them.

Check: `npm run check` (typecheck, tests, smoke). Tests need no network or keys.
