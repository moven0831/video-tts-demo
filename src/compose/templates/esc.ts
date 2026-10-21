const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
}

export function num(value: number): number {
  return Math.round(value * 1000) / 1000;
}
