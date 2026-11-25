// CONTROLLER (floor plans): the deck of floor plans on the right of the screen. It appears once the wind tunnels are finished
// and the circulation is planned, and is made again when either changes. The floors are cards in a stack, the higher ones
// tipped away above and the lower below; the one landed on faces flat out of the screen. Go through them with the mouse
// wheel, the arrow keys, the level buttons, a swipe, or by clicking a card.
import * as THREE from "three";
import { $ } from "../core/dom.js";
import { on } from "../core/events.js";
import { onFrame } from "../view/scene.js";
import { getMassInfo } from "../mass/model3dm.js";
import { getFinishedTunnels } from "../erosion/exterior/index.js";
import { getCirculationPlan } from "../erosion/circulation/index.js";
import { drawFloorPlans } from "./draw.js";
import { lettering } from "./lettering.js";

const SETTLE = 500; // ms a new plan must stand before it is drawn (the tunnels are still being moved round main cores)
const WHEEL_STEP = 60; // of wheel travel to a floor
const WHEEL_WAIT = 180; // ms at the least between floors

let drawn = null; // the circulation plan the cards show
let wanted = null, wantedSince = 0;
let cards = []; // [{ element, sheet }] from the ground up
let current = 0;
let shut = false; // the deck folded away by its button

// every triangle of the massings' own meshes
function meshTriangles(visit) {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  getMassInfo()?.object.traverse((mesh) => {
    const position = mesh.isMesh && mesh.geometry?.attributes.position;
    if (!position) return;
    const index = mesh.geometry.index, count = index ? index.count : position.count;
    mesh.updateWorldMatrix(true, false);
    for (let i = 0; i + 2 < count; i += 3) {
      [a, b, c].forEach((v, n) => v.fromBufferAttribute(position, index ? index.getX(i + n) : i + n).applyMatrix4(mesh.matrixWorld));
      visit(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  });
}

// Places the cards round the current one.
function arrange() {
  cards.forEach(({ element }, i) => {
    const away = i - current, far = Math.abs(away);
    element.style.transform = away === 0
      ? "translate3d(0, 0, 0)"
      : `translate3d(0, ${-Math.sign(away) * (44 + far * 26)}%, ${-110 - far * 70}px) rotateX(${-Math.sign(away) * 42}deg)`;
    element.style.zIndex = String(100 - far);
    element.style.opacity = far > 2 ? "0" : String(1 - far * 0.28);
    element.style.pointerEvents = far > 2 ? "none" : "auto";
    element.classList.toggle("current", away === 0);
    element.setAttribute("aria-hidden", String(away !== 0));
  });
  document.querySelectorAll("#floorplan-levels button").forEach((button) => {
    const chosen = Number(button.dataset.index) === current;
    button.classList.toggle("on", chosen);
    button.setAttribute("aria-pressed", String(chosen));
  });
  $("floorplan-up").disabled = current >= cards.length - 1;
  $("floorplan-down").disabled = current <= 0;
}

function go(index) {
  const next = Math.max(0, Math.min(cards.length - 1, index));
  if (next === current) return;
  current = next;
  arrange();
}

function card(sheet, total) {
  const element = document.createElement("article");
  element.className = "floorplan-card";
  const facts = [
    `${Math.round(sheet.area)} m² floor`,
    `${Math.round(sheet.hallway)} m hallway`,
    `${sheet.stairs} stair${sheet.stairs === 1 ? "" : "s"}`,
    sheet.lifts ? `${sheet.lifts} lift${sheet.lifts === 1 ? "" : "s"}` : "",
    `${sheet.openings} wind opening${sheet.openings === 1 ? "" : "s"}`,
  ].filter(Boolean);
  element.innerHTML = `
    <header><h3>${lettering(`LEVEL ${sheet.level}`)}</h3><span>${lettering(`${sheet.level}  /  ${total}`, false)}</span></header>
    <div class="floorplan-sheet">${sheet.svg}</div>
    <p class="floorplan-facts">${facts.join(" · ")}</p>`;
  return element;
}

function rebuild(sheets) {
  const deck = $("floorplan-deck"), levels = $("floorplan-levels");
  cards = sheets.map((sheet, i) => {
    const element = card(sheet, sheets.length);
    element.addEventListener("click", () => go(i));
    return { element, sheet };
  });
  deck.replaceChildren(...cards.map((c) => c.element));
  levels.replaceChildren(...sheets.map((sheet, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.index = String(i);
    button.textContent = String(sheet.level);
    button.setAttribute("aria-label", `Level ${sheet.level}`);
    button.addEventListener("click", () => go(i));
    return button;
  }).reverse()); // (the top floor at the top, as in a lift)
  current = Math.min(current, cards.length - 1);
  arrange();
}

function show(on) {
  $("floorplans").classList.toggle("hidden", !on);
}

function clear() {
  drawn = wanted = null;
  cards = [];
  current = 0;
  $("floorplan-deck").replaceChildren();
  $("floorplan-levels").replaceChildren();
  show(false);
}

function frame() {
  const circulation = getCirculationPlan(), tunnels = getFinishedTunnels();
  if (!circulation || !tunnels) {
    if (drawn || wanted) { drawn = wanted = null; show(false); } // (the level being looked at is kept for the next drawing)
    return;
  }
  if (circulation === drawn) return;
  if (circulation !== wanted) {
    wanted = circulation;
    wantedSince = performance.now();
    if (drawn) show(false); // (the old sheets no longer hold)
    return;
  }
  if (performance.now() - wantedSince < SETTLE) return;
  drawn = circulation;
  try {
    const sheets = drawFloorPlans({ plan: circulation, tunnels, triangles: meshTriangles });
    if (!sheets.length) return show(false);
    rebuild(sheets);
    show(true);
  } catch (e) {
    console.error("The floor plans could not be drawn:", e);
    show(false);
  }
}

function mount() {
  const root = $("floorplans"), deck = $("floorplan-deck");
  $("floorplan-up").addEventListener("click", () => go(current + 1));
  $("floorplan-down").addEventListener("click", () => go(current - 1));
  $("floorplan-toggle").addEventListener("click", () => {
    shut = !shut;
    root.classList.toggle("shut", shut);
    $("floorplan-toggle").setAttribute("aria-expanded", String(!shut));
    $("floorplan-toggle").textContent = shut ? "Floor plans ◂" : "Hide ▸";
  });
  // the wheel goes through the deck (up for the floor above) and never zooms the model behind it
  let travel = 0, last = 0;
  root.addEventListener("wheel", (e) => {
    if (shut) return;
    e.preventDefault();
    e.stopPropagation();
    travel += e.deltaY;
    if (Math.abs(travel) < WHEEL_STEP || performance.now() - last < WHEEL_WAIT) return;
    go(current - Math.sign(travel));
    travel = 0;
    last = performance.now();
  }, { passive: false });
  root.addEventListener("keydown", (e) => {
    const step = { ArrowUp: 1, PageUp: 1, ArrowDown: -1, PageDown: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    go(current + step);
  });
  let pressed = null;
  deck.addEventListener("pointerdown", (e) => { pressed = e.clientY; });
  addEventListener("pointerup", (e) => {
    if (pressed !== null && Math.abs(e.clientY - pressed) > 45) go(current + Math.sign(e.clientY - pressed)); // (drag down to bring the floor above)
    pressed = null;
  });
  onFrame(frame);
  on("site:cleared", clear);
}

mount();
