export type Segment = { text: string; at?: number };

const TIMESTAMP = /^#\s*(?:(\d+):)?(\d+):(\d{2})(?=\s|$)/;

function seconds(match: RegExpExecArray): number {
  const [, h, m, s] = match;
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
}

export function splitSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let block: string[] = [];
  let at: number | undefined;
  const endBlock = () => {
    const text = block.join("\n").trim();
    if (text !== "") segments.push(at === undefined ? { text } : { text, at });
    block = [];
    at = undefined;
  };
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed === "") {
      endBlock();
    } else if (trimmed.startsWith("#")) {
      const match = TIMESTAMP.exec(trimmed);
      if (match && at === undefined) at = seconds(match);
    } else {
      block.push(line);
    }
  }
  endBlock();
  return segments;
}
