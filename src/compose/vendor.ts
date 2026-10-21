import { fileURLToPath } from "node:url";

export const INTER_WEIGHTS = [400, 600, 700, 800] as const;

const modules = fileURLToPath(new URL("../../node_modules/", import.meta.url));

export const VENDORED: { from: string; to: string }[] = [
  { from: `${modules}gsap/dist/gsap.min.js`, to: "assets/gsap.min.js" },
  ...INTER_WEIGHTS.map((weight) => ({
    from: `${modules}@fontsource/inter/files/inter-latin-${weight}-normal.woff2`,
    to: `assets/fonts/inter-${weight}.woff2`,
  })),
];
