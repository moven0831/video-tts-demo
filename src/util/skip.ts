import { spawnSync } from "node:child_process";

// With REQUIRE_SMOKE set a missing ffmpeg fails the test that needs it instead of skipping it.
export function ffmpegSkip(): string | false {
  if (process.env.REQUIRE_SMOKE) return false;
  return spawnSync("ffmpeg", ["-version"]).error ? "ffmpeg is not installed" : false;
}
