export type Window = { start: number; end: number };
export type LanePoint = { t: number; db: number };

const RAMP_SEC = 0.3;
const MERGE_GAP_SEC = 0.6;

export function duckingLane(
  windows: Window[],
  total: number,
  gainDb: number,
  duckDb: number,
): LanePoint[] {
  const merged: Window[] = [];
  for (const window of [...windows].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && window.start - last.end < MERGE_GAP_SEC) last.end = Math.max(last.end, window.end);
    else merged.push({ ...window });
  }

  const ducked = gainDb + duckDb;
  const points: LanePoint[] = [{ t: 0, db: gainDb }];
  for (const { start, end } of merged) {
    points.push(
      { t: Math.max(0, start - RAMP_SEC), db: gainDb },
      { t: start, db: ducked },
      { t: end, db: ducked },
      { t: Math.min(total, end + RAMP_SEC), db: gainDb },
    );
  }

  // The later point wins on a shared time, so a window at t = 0 still ducks.
  const byTime = new Map<number, LanePoint>();
  for (const point of points) byTime.set(point.t, point);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}
