// MODEL (interior erosion): the occupied spaces the user places inside the mass. No scene or DOM code.
//
// A space is a sphere: { id, kind: "cold" | "warm", label, x, y, z, r } in world metres (x east, y up, z south), r its radius. Spheres may
// overlap, and then they make one connected space. How cold and warm spaces differ is not decided yet: for now the only thing they do is
// keep the wind tunnels out (the exterior erosion reads getSpaces() and grows its tunnels round them, see exterior/tunnels.js).
//
// Events: "spaces:changed" (the list or a sphere changed), "spaces:selected" ({id}), "spaces:mode" ({mode}).
import { emit } from "../../core/events.js";
import { registerPersist } from "../../core/persist.js";

export const SPACE_KINDS = {
  cold: { label: "Cold space", colour: 0x3f8fd6 },
  warm: { label: "Warm space", colour: 0xe0702f },
};
export const MIN_RADIUS = 0.5;

let list = [];
let serial = { cold: 0, warm: 0 };
let nextId = 1, selected = null, version = 0;
let mode = "move"; // what the gizmo on the selected sphere does: "move" (x, y and z) or "scale" (its radius)

export const getSpaces = () => list; // read only: change spaces with the functions below
export const spacesVersion = () => version;
export const getSelectedId = () => selected;
export const getSelected = () => list.find((s) => s.id === selected) ?? null;
export const getGizmoMode = () => mode;

// A string that changes whenever any sphere does (for noticing changes).
export const spacesSignature = () => list.map((s) => `${s.id}:${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)},${s.r.toFixed(2)}`).join(";");

const changed = () => { version++; emit("spaces:changed"); };

// Adds a sphere of `kind` ("cold" or "warm") at `at` ({x, y, z, r}, any of them left out) and selects it. Returns it.
export function addSpace(kind, at = {}) {
  if (!SPACE_KINDS[kind]) throw new Error(`Unknown kind of space: ${kind}`);
  const n = ++serial[kind];
  const space = { id: nextId++, kind, label: `${kind === "cold" ? "Cold" : "Warm"} ${n}`, x: at.x ?? 0, y: at.y ?? 6, z: at.z ?? 0, r: Math.max(MIN_RADIUS, at.r ?? 4) };
  list = [...list, space];
  selected = space.id;
  changed();
  emit("spaces:selected", { id: selected });
  return space;
}

// Changes some of a sphere's numbers: patch = { x, y, z, r } (any of them).
export function updateSpace(id, patch) {
  const s = list.find((q) => q.id === id);
  if (!s) return;
  let any = false;
  for (const key of ["x", "y", "z", "r"]) {
    if (patch[key] === undefined || !Number.isFinite(patch[key])) continue;
    const v = key === "r" ? Math.max(MIN_RADIUS, patch[key]) : patch[key];
    if (s[key] !== v) { s[key] = v; any = true; }
  }
  if (any) changed();
}

export function removeSpace(id) {
  if (!list.some((s) => s.id === id)) return;
  list = list.filter((s) => s.id !== id);
  if (selected === id) { selected = null; emit("spaces:selected", { id: null }); }
  changed();
}

export function selectSpace(id) {
  const next = list.some((s) => s.id === id) ? id : null;
  if (next === selected) return;
  selected = next;
  emit("spaces:selected", { id: selected });
}

export function setGizmoMode(next) {
  if (next !== "move" && next !== "scale") return;
  mode = next;
  emit("spaces:mode", { mode });
}

export function clearSpaces() {
  list = [];
  serial = { cold: 0, warm: 0 };
  selected = null;
  changed();
  emit("spaces:selected", { id: null });
}

registerPersist("interiorSpaces", {
  capture: () => ({ list: list.map((s) => ({ ...s })), serial: { ...serial }, nextId }),
  restore: (saved) => {
    list = (saved.list ?? []).map((s) => ({ ...s }));
    serial = { cold: 0, warm: 0, ...(saved.serial ?? {}) };
    nextId = saved.nextId ?? list.reduce((m, s) => Math.max(m, s.id + 1), 1);
    selected = null;
    changed();
    emit("spaces:selected", { id: null });
  },
});
