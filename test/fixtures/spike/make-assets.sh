#!/usr/bin/env bash
# Regenerates the spike media. Run from anywhere.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
a="$here/assets"
mkdir -p "$a"
ffmpeg -y -v error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=10" \
  -c:v libx264 -pix_fmt yuv420p -crf 14 -g 30 "$a/src.mp4"
ffmpeg -y -v error -f lavfi -i "sine=frequency=440:duration=3" -c:a libmp3lame "$a/tone.mp3"
# Last frame of clip B: source 0-1 s at rate 0.5, so source frame 29.
# The matrix must be explicit: src.mp4 is untagged, ffmpeg assumes bt601 for the
# png while Chrome decodes the video as bt709, and the still would change colour.
ffmpeg -y -v error -i "$a/src.mp4" \
  -vf "select=eq(n\,29),scale=in_color_matrix=bt709:out_color_matrix=bt709" -vsync 0 -frames:v 1 "$a/freeze.png"
cp "$here/../../../node_modules/gsap/dist/gsap.min.js" "$a/gsap.min.js"
