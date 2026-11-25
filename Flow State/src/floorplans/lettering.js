// VIEW (floor plans): thin, wide-set, single-line capitals for the sheets' titles, drawn as strokes in the manner of a
// draughtsman's lettering (no font is needed). Each letter is drawn in a box 10 high: [width, path].
const LETTERS = {
  L: [6, "M0 0V10H6"],
  E: [6, "M6 0H0V10H6M0 4.2H5"],
  V: [8, "M0 0L4 10L8 0"],
  "/": [6, "M0 10L6 0"],
  0: [7, "M3.5 0C.8 0 0 2.2 0 5S.8 10 3.5 10S7 7.8 7 5S6.2 0 3.5 0Z"],
  1: [3, "M0 2.2L3 0V10"],
  2: [6, "M0 2.6C.2 .8 1.4 0 3 0C4.8 0 6 1.1 6 2.8C6 4.2 5.2 5.2 0 10H6.4"],
  3: [6, "M.2 0H6L2.4 4.2C4.8 3.9 6 5.2 6 7C6 8.9 4.6 10 3 10C1.6 10 .6 9.4 0 8.2"],
  4: [7, "M5 10V0L0 7H7"],
  5: [6, "M5.6 0H.8L.4 4.6C1.2 4 2.2 3.8 3 3.8C5 3.8 6 5.1 6 6.9C6 8.8 4.7 10 2.9 10C1.6 10 .6 9.4 0 8.4"],
  6: [6, "M4.8 0L.8 5.2M.8 5.2C.3 5.9 0 6.5 0 7.1C0 8.9 1.3 10 3 10S6 8.8 6 7S4.7 4.2 3 4.2C2.1 4.2 1.3 4.6 .8 5.2"],
  7: [6, "M0 0H6L1.8 10"],
  8: [6, "M3 0C1.5 0 .5 .9 .5 2.3S1.5 4.6 3 4.6S5.5 3.7 5.5 2.3S4.5 0 3 0ZM3 4.6C1.2 4.6 0 5.7 0 7.3S1.2 10 3 10S6 8.9 6 7.3S4.8 4.6 3 4.6Z"],
  9: [6, "M5.2 4.8C4.7 5.4 3.9 5.8 3 5.8C1.3 5.8 0 4.7 0 2.9S1.3 0 3 0S6 1.1 6 2.9C6 3.5 5.7 4.1 5.2 4.8L1.2 10"],
};
const SPACE = 4, GAP = 2.2;

// An SVG of the text (letters of LETTERS and spaces), as tall as its CSS makes it, with a fine line running on from the top
// of the lettering.
export function lettering(text, rule = true) {
  let x = 0, d = "";
  for (const ch of text.toUpperCase()) {
    const letter = LETTERS[ch];
    if (!letter) { x += SPACE; continue; }
    d += `<path transform="translate(${x} 0)" d="${letter[1]}"/>`;
    x += letter[0] + GAP;
  }
  const width = x - GAP;
  return `<svg class="floorplan-lettering" viewBox="-1 -1.5 ${width + 2} 13" role="img" aria-label="${text}">` +
    `<g fill="none" stroke="currentColor" stroke-width="1" vector-effect="non-scaling-stroke">${d.replaceAll("<path ", '<path vector-effect="non-scaling-stroke" ')}` +
    (rule ? `<path vector-effect="non-scaling-stroke" d="M0 0H${width}" opacity="0.55"/>` : "") + `</g></svg>`;
}
