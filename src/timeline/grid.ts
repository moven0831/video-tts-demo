export const OUTPUT_FPS = 30;

// Compose writes clip times at millisecond precision and HyperFrames reads them back from the HTML.
const ms = (value: number) => Math.round(value * 1000) / 1000;
const FRAME_EPSILON = 1e-3;

// HyperFrames extracts the source at the output fps starting from `in` and shows extracted frame
// floor(local time * rate * fps) at each output frame, so this is the index of the extracted frame
// on screen at the last output frame of the video part (output frames sit on n / fps).
export function lastShownFrame(start: number, videoEnd: number, rate: number): number {
  const first = ms(start);
  const end = first + ms(videoEnd - start);
  const firstFrame = Math.ceil(first * OUTPUT_FPS - FRAME_EPSILON);
  const lastFrame = Math.max(firstFrame, Math.ceil(end * OUTPUT_FPS - FRAME_EPSILON) - 1);
  const local = Math.max(0, lastFrame / OUTPUT_FPS - first);
  return Math.floor(local * ms(rate) * OUTPUT_FPS + 1e-9);
}
