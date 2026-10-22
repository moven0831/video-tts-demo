---
name: demo-video
description: Turn a silent screen recording into a finished demo video with voiceover, captions, cards, and camera moves. Use when the user wants a demo video, product walkthrough, or narrated tour made from projects/<name>/input.mp4.
---

# Demo video

You are the director. You look at the recording, write `projects/<name>/edit-plan.json`, and run the
deterministic stages. Each gate below needs an explicit yes from the user before you continue.

`<name>` is the folder under `projects/`. All commands run from the repo root.

## Credentials

Keys live in `.env.local`: `ANTHROPIC_API_KEY` (or an `ant auth login` profile) for `npm run plan`,
`ELEVENLABS_API_KEY` for voice. Never read `.env*` in this session. Do not run the ElevenLabs
skills' `npx @elevenlabs/cli@latest onboard` suggestion; ask the user to add the key to `.env.local`.

## 0. Intake

- Confirm `projects/<name>/input.mp4` exists. Read `projects/<name>/brief.md` if there is one.
- Ask one round of questions, only for what the brief leaves open: audience, tone, target length,
  voice, music (none, a file in `projects/<name>/music/`, or generated).
- Say plainly that sampled frames of the recording are sent to the Anthropic API when planning runs
  over the API, and to ElevenLabs as narration text (plus ElevenLabs' own audio when it aligns a line), never as video. If the recording shows
  anything private, stop and ask first.

## 1. Probe

```
npm run probe -- <name>
```

Read, in this order: `build/contact.jpg` (overview), `build/scenes.json` (cuts), `build/motion.json`
(changed region per second, idle spans), then the sheets in `build/sheets/NN.jpg`. Each tile's
source time is in `build/sheets/index.json`; use it to convert tile positions to source seconds and
source pixels (the conversion is spelled out in `src/director/DIRECTOR.md`).

If probe warns of a variable frame rate (typical for screen captures), freeze frames and
timestamps can drift. Re-encode first:
`ffmpeg -i in.mov -vf fps=30 -c:v libx264 -crf 16 input.mp4`.

## 2. Plan

Two routes, same output:

- Session route (default, interactive): write `projects/<name>/edit-plan.json` yourself, following
  `src/director/DIRECTOR.md` and the schema in `src/schema/edit-plan.schema.json`. Set `meta.source`
  to `width`, `height`, `fps` and `duration` from `build/probe.json`; do not copy the whole file.
- Seed route (optional): `npm run plan -- <name> --from-narration narration.txt` splits a narration
  file into one scene per block (a `# m:ss` line sets a block's start) without any API call. Refine
  the result by hand. It refuses to overwrite an existing plan without `--force`.
- API route (unattended): `npm run plan -- <name>` prints a cost estimate; add `--yes` to spend. It
  refuses to overwrite an existing plan without `--force`. If the reply fails validation, it is saved
  to `build/plan.rejected.json`; repair it and save it as `edit-plan.json`.

Then:

```
npm run plan:check -- <name>
```

Fix every error and re-run. Gate: zero errors, and the user approves a table of chapters and scenes
with source spans and estimated speech seconds (the check prints it). Revisit warnings with the user.

## 3. Voice (spends credits)

```
npm run voice -- <name> --dry-run
```

Show the resolved voice and model, the line count, character totals, and any ElevenLabs cost the
output reports. Gate: the user
approves the spend. Only then:

```
npm run voice -- <name> --yes
```

Without `--yes`, `voice` writes `voice.json` only when every line, sound effect and music clip is
already cached; otherwise it prints the spend and exits 3. `timeline` refuses a `voice.json` that no
longer matches the plan, so rerun `voice` after any change to a line, an sfx cue or the music.

For voice choice, SFX prompts, or music, consult the ElevenLabs skills (`text-to-speech`,
`sound-effects`, `music`) and, to audition, `npm run voice -- <name> --audition "<text>" --voices a,b`.
The ElevenLabs MCP server in `.mcp.json` can browse voices; it is optional and needs OAuth.

## 4. Build a draft

```
npm run timeline -- <name>
npm run compose -- <name>
npm run render -- <name> --draft
npm run mux -- <name>
```

Show `projects/<name>/out/contact.jpg` and report the duration, and relay any warnings the stages
print. `render` and `mux` fail on a missing or silent audio track. Iterate by editing
`edit-plan.json` only, then re-run from `plan:check`. Unchanged lines come from the cache, but an
edited line is re-voiced together with its neighbours, because each line is voiced with the text
on either side as context. For layout, motion, or composition questions, use the `/hyperframes:*` skills.

## 5. Final

Render at full quality with `npm run render -- <name>` (no `--draft`), then `npm run mux -- <name>`
(run `timeline` and `compose` first if the plan or voice changed).
Outputs: `out/final.mp4`, `out/final.srt`, `out/final.vtt`. `npm run demo -- <name>` runs all stages
and skips those whose inputs have not changed; pass `--draft` or `--force` as needed. Add `--yes` to
let it spend after the voice gate (`npm run demo -- <name> --yes`). Add `--plan` to run the API
director when `edit-plan.json` is missing; that also needs `--yes`. `demo` prints the warnings at the
end; read them with the user. Note that `demo --plan --yes`
approves both the director spend and the voice spend at once, unlike the step-by-step flow, which
gates them separately; only use it after the user has agreed to both.

## Rules

- Edit `edit-plan.json` only. Never edit anything under `build/` or `out/`; they are derived.
- Never narrate anything that is not visible in the frames or stated in the brief.
- A stage that fails prints one `error:` line; `DEBUG=1` adds the stack.
- Plan limits that trip stages: narration lines must not overlap, sfx `sec` is 0.5 to 30, and
  `music.file` is a bare filename in `projects/<name>/music/`. `push` transitions render as dissolves.
- Never run a spending command (`voice --yes`, `plan --yes`) without the gate above.
- If a stage fails, read its error, fix the plan or the input, and re-run; do not hand-patch outputs.
- HyperFrames is pinned. Do not upgrade it to fix a problem; report the problem instead.
