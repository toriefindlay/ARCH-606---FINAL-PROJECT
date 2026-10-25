// Anything that should come back when a saved site is reopened registers here:
//
//   registerPersist("myKey", {
//     capture: () => serialisableValue,
//     restore: (value, extras) => {},   // may be async; extras = { modelBuffer }
//   });
//
// Parts are captured and restored in registration order (the import order in main.js).
const parts = new Map();

export function registerPersist(key, part) {
  parts.set(key, part);
}

export function captureAll() {
  const out = {};
  for (const [key, part] of parts) out[key] = part.capture();
  return out;
}

export async function restoreAll(saved, extras = {}) {
  if (!saved) return;
  for (const [key, part] of parts) {
    if (saved[key] !== undefined) await part.restore(saved[key], extras);
  }
}
