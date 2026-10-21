---
name: demo-video
description: Turn a silent screen recording into a finished demo video with voiceover, captions, cards, and camera moves. Use when the user wants a demo video, product walkthrough, or narrated tour made from projects/<name>/input.mp4.
---

# Demo video

You are the director. You look at the recording, write `projects/<name>/edit-plan.json`, and run the
deterministic stages. Each gate below needs an explicit yes from the user before you continue.

`<name>` is the folder under `projects/`. All commands run from the repo root.

## 0. Intake

- Confirm `projects/<name>/input.mp4` exists. Read `projects/<name>/brief.md` if there is one.
- Ask one round of questions, only for what the brief leaves open: audience, tone, target length,
  voice, music (none, a file in `projects/<name>/music/`, or generated).
- Say plainly that sampled frames of the recording are sent to the Anthropic API when planning runs
  over the API, and to ElevenLabs only as text (narration), never as video. If the recording shows
  anything private, stop and ask first.

## 1. Probe

```
npm run probe -- <name>
```

Read, in this order: `build/contact.jpg` (overview), `build/scenes.json` (cuts), `build/motion.json`
(changed region per second, idle spans), then the sheets in `build/sheets/NN.jpg`. Each tile's
source time is in `build/sheets/index.json`; use it to convert tile positions to source seconds and
source pixels (the conversion is spelled out in `src/director/DIRECTOR.md`).

## 2. Plan

Two routes, same output:

- Session route (default, interactive): write `projects/<name>/edit-plan.json` yourself, following
  `src/director/DIRECTOR.md` and the schema in `src/schema/edit-plan.schema.json`. Include `meta.source`
  copied from `build/probe.json`.
- API route (unattended): `npm run plan -- <name>` prints a cost estimate; add `--yes` to spend. It
  refuses to overwrite an existing plan without `--force`.

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

Show the line count, character totals, and any ElevenLabs cost the output reports. Gate: the user
approves the spend. Only then:

```
npm run voice -- <name> --yes
```

For voice choice, SFX prompts, or music, consult the ElevenLabs skills (`text-to-speech`,
`sound-effects`, `music`) and, to audition, `npm run voice -- <name> --audition "<text>" --voices a,b`.
The ElevenLabs MCP server in `.mcp.json` can browse voices; it is optional and needs OAuth.

## 4. Build a draft

```
npm run compose -- <name>
npm run render -- <name> --draft
npm run mux -- <name>
```

Show `projects/<name>/out/contact.jpg` and report the duration. Iterate by editing `edit-plan.json`
only, then re-run from `plan:check` (voice re-spends only for changed lines; unchanged lines are
cached). For layout, motion, or composition questions, use the `/hyperframes:*` skills.

## 5. Final

Render at full quality with `npm run render -- <name>` (no `--draft`), then `npm run mux -- <name>`.
Outputs: `out/final.mp4`, `out/final.srt`, `out/final.vtt`. `npm run demo -- <name>` runs all stages
and skips those whose inputs have not changed; pass `--draft` or `--force` as needed.

## Rules

- Edit `edit-plan.json` only. Never edit anything under `build/` or `out/`; they are derived.
- Never narrate anything that is not visible in the frames or stated in the brief.
- Never run a spending command (`voice --yes`, `plan --yes`) without the gate above.
- If a stage fails, read its error, fix the plan or the input, and re-run; do not hand-patch outputs.
- HyperFrames is pinned. Do not upgrade it to fix a problem; report the problem instead.
