import { copyFile, link, mkdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EditPlan } from "../schema/edit-plan.ts";
import type { Timeline } from "../timeline/types.ts";
import type { Probe } from "../schema/artifacts.ts";
import { colorMatrix } from "../probe/frames.ts";
import { OUTPUT_FPS } from "../timeline/grid.ts";
import { run } from "../util/exec.ts";
import { writeAtomic } from "../util/fs.ts";
import { compose } from "./compose.ts";

// The still is the extracted frame the video part shows last: freeze.at counts output frames from
// the clip's media start. There is no clamp to the probed frame count; a frame the extraction
// lacks is reported by writeStill instead of being swapped for a different one.
export function stillIndex(at: number, mediaStart: number): number {
  return Math.round((at - mediaStart) * OUTPUT_FPS);
}

// The filters HyperFrames puts in front of its own frame extraction (videoFrameExtractor in the
// hyperframes package). The still has to come out of the same chain: counting source frames picks
// another frame for sources at a higher or variable frame rate.
export function samplingFilters(seek: number, lead: number, vfr: boolean): string[] {
  return [
    ...(vfr
      ? []
      : [
          "settb=AVTB",
          `setpts=if(isnan(FR)\\,PTS\\,(${lead}+round((PTS*TB+${seek}-${lead})*FR)/FR-${seek})/TB)`,
        ]),
    "settb=intb/2",
    "setpts=PTS-lte(TB\\,0.001)",
    `fps=${OUTPUT_FPS}:start_time=0:round=up`,
  ];
}

type ProbedStream = {
  codec_type?: string;
  start_time?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  disposition?: { attached_pic?: number };
};

function frameRate(value: string | undefined): number {
  const [num, den] = (value ?? "").split("/").map(Number);
  const fps = num / (den ?? 1);
  return Number.isFinite(fps) ? fps : 0;
}

// HyperFrames' own rules: the video starts `lead` after the earliest audio or video stream, and a
// source is variable-rate when r_frame_rate and avg_frame_rate differ by over 10%.
export function parseStreamTraits(json: { streams: ProbedStream[] }): { lead: number; vfr: boolean } {
  const starts = json.streams
    .filter(
      (s) =>
        (s.codec_type === "audio" || s.codec_type === "video") && s.disposition?.attached_pic !== 1,
    )
    .map((s) => parseFloat(s.start_time ?? ""))
    .filter(Number.isFinite);
  const video = json.streams.find((s) => s.codec_type === "video");
  const start = parseFloat(video?.start_time ?? "");
  const lead =
    Number.isFinite(start) && starts.length > 0 ? Math.max(0, start - Math.min(...starts)) : 0;
  const nominal = frameRate(video?.r_frame_rate);
  const average = frameRate(video?.avg_frame_rate);
  const vfr =
    nominal > 0 && average > 0 && Math.abs(nominal - average) / Math.max(nominal, average) > 0.1;
  return { lead, vfr };
}

async function streamTraits(input: string): Promise<{ lead: number; vfr: boolean }> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-print_format", "json", "-show_streams", input,
  ]);
  return parseStreamTraits(JSON.parse(stdout));
}

type StillSpec = { mediaStart: number; index: number; matrix: string; lead: number; vfr: boolean };

// ffmpeg exits 0 and writes nothing when the select expression matches no frame.
export async function writeStill(
  input: string,
  to: string,
  { mediaStart, index, matrix, lead, vfr }: StillSpec,
  label: { scene: string; at: number },
): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  const filters = [
    ...samplingFilters(mediaStart, lead, vfr),
    `select=eq(n\\,${index})`,
    `scale=in_color_matrix=${matrix}:out_color_matrix=${matrix}`,
  ];
  await run("ffmpeg", [
    "-y", "-v", "error", "-noaccurate_seek", "-ss", String(mediaStart), "-i", input,
    "-vf", filters.join(","), "-fps_mode", "passthrough", "-frames:v", "1", to,
  ]);
  const size = await stat(to).then((s) => s.size, () => 0);
  if (size === 0) {
    throw new Error(
      `could not extract the freeze frame for scene "${label.scene}" at ${label.at} s ` +
        `(frame ${index} from ${mediaStart} s); the recording may end before the scene does`,
    );
  }
}

const LINK_FALLBACK = new Set(["EXDEV", "EPERM", "ENOTSUP", "EMLINK"]);

export async function place(from: string, to: string, linkFile: typeof link = link): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await linkFile(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOENT") {
      throw new Error(`${from} is missing; rerun the stage that writes it (voice for audio)`);
    }
    if (!LINK_FALLBACK.has(code)) throw err;
    await copyFile(from, to);
  }
}

export async function writeHf(
  build: string,
  hf: string,
  input: string,
  timeline: Timeline,
  plan: EditPlan,
  probe: Probe,
): Promise<string[]> {
  const result = compose(timeline, plan);
  await rm(hf, { recursive: true, force: true });
  for (const [path, text] of Object.entries(result.files)) await writeAtomic(join(hf, path), text);
  for (const { from, to } of result.copies) {
    const src = isAbsolute(from) ? from : resolve(build, from);
    await place(src, join(hf, to));
  }
  const matrix = colorMatrix(probe);
  const { lead, vfr } =
    result.stills.length > 0 ? await streamTraits(input) : { lead: 0, vfr: false };
  for (const still of result.stills) {
    const { mediaStart } = still;
    const index = stillIndex(still.at, mediaStart);
    await writeStill(input, join(hf, still.to), { mediaStart, index, matrix, lead, vfr }, still);
  }
  return result.warnings;
}
