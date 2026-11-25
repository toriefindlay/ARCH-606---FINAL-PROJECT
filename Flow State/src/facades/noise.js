// MODEL (facades): a fixed pseudo-random number 0..1 for a pair of numbers.
export const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
