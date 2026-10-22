import type { Probe } from "../schema/artifacts.ts";
import { run } from "../util/exec.ts";

type Stream = {
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  color_space?: string;
  nb_frames?: string;
  duration?: string;
};
export type ProbeJson = { streams: Stream[]; format: { duration?: string } };

const VFR_TOLERANCE = 0.01;

export const VFR_WARNING =
  "the recording has a variable frame rate, so freeze frames and timestamps can drift; " +
  "re-encode it first: ffmpeg -i in.mov -vf fps=30 -c:v libx264 -crf 16 input.mp4";

function rate(value: string | undefined): number | undefined {
  const [num, den] = (value ?? "").split("/").map(Number);
  const fps = num / (den ?? 1);
  return Number.isFinite(fps) && fps > 0 ? fps : undefined;
}

export function parseProbe(json: ProbeJson): Probe {
  const video = json.streams.find((s) => s.codec_type === "video");
  if (!video || !video.width || !video.height) throw new Error("no video stream in the input");
  const fps = rate(video.avg_frame_rate) ?? rate(video.r_frame_rate);
  if (fps === undefined) throw new Error("input has no frame rate");
  const probe: Probe = {
    width: video.width,
    height: video.height,
    fps,
    duration: Number(json.format.duration),
  };
  if (video.color_space && video.color_space !== "unknown") probe.colorSpace = video.color_space;
  const counted = Number(video.nb_frames);
  const estimated = Math.floor(Number(video.duration) * fps);
  const frames = counted > 0 ? counted : estimated;
  if (Number.isFinite(frames) && frames > 0) probe.frames = frames;
  const nominal = rate(video.r_frame_rate);
  if (nominal !== undefined && Math.abs(nominal - fps) / fps > VFR_TOLERANCE) probe.vfr = true;
  return probe;
}

async function ffprobe(input: string): Promise<ProbeJson> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    input,
  ]);
  return JSON.parse(stdout);
}

export async function probeVideo(input: string): Promise<Probe> {
  return parseProbe(await ffprobe(input));
}

export async function audioDuration(input: string): Promise<number> {
  return Number((await ffprobe(input)).format.duration);
}
