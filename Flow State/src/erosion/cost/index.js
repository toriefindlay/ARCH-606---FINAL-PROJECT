// Mounts the cost savings panel: once the wind tunnels are finished, works out what their cooling saves against air conditioning (rules.js) from the building's
// floor area, the average cooling of its floors, the site's climate (the year's temperatures, already loaded for the wind) and the electricity price of the site's
// region and currency. Read-only: it changes nothing in the model.
import { $ } from "../../core/dom.js";
import { state } from "../../core/state.js";
import { onFrame } from "../../view/scene.js";
import { getFinishedTunnels } from "../exterior/index.js";
import { STOREY } from "../exterior/tunnels.js";
import { requestWind, getCoolingHours } from "../../site/wind.js";
import { regionOf, floorArea, estimate, ASSUMPTIONS } from "./rules.js";
import { mountPanel, settings, show } from "./panel.js";

let lastKey = "";
let area = 0, areaKey = "", share = 0, shareKey = "";

const money = (v, currency) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v); } catch { return `${currency} ${v.toFixed(0)}`; }
};
const num = (v, d = 0) => v.toLocaleString(undefined, { maximumFractionDigits: d });

function frame() {
  const site = state.site, t = getFinishedTunnels();
  if (!site) { lastKey = ""; return show({ note: "Open a site and place a mass first." }); }
  if (!t) { lastKey = ""; return show({ note: "Waiting for the wind tunnels to finish (turn them on under Passive cooling)." }); }
  requestWind();
  const climate = getCoolingHours(ASSUMPTIONS.base);
  if (!climate) { lastKey = ""; return show({ note: "Loading the site's temperatures…" }); }
  const region = regionOf(site.lat, site.lon);
  const price = settings.price ?? region.price;
  const key = `${t.id}|${t.baseVersion}|${t.version}|${site.lat}|${site.lon}|${price}|${climate.year}`;
  if (key === lastKey) return;
  lastKey = key;
  // (the floor area and the cooling are worked out when the tunnels change, not when only the price does)
  const k = `${t.id}|${t.version}`;
  if (areaKey !== k) { areaKey = k; area = floorArea(t.heightAt, t.massBox, STOREY, t.storeys); }
  if (shareKey !== k) { shareKey = k; share = t.cooling()?.mean ?? 0; }
  if (!area) return show({ note: "The mass has no floor area to cool." });
  const r = estimate({ area, share, climate, price });
  const cur = region.currency;
  const rows = [
    ["Site", `${site.lat.toFixed(2)}, ${site.lon.toFixed(2)}: ${region.name}, prices in ${cur}`],
    ["Building", `${num(area)} m² of floor on ${t.storeys} storeys`],
    ["Climate", `${num(climate.hours)} hours a year above ${ASSUMPTIONS.base} °C (${climate.year}), mean ${climate.mean.toFixed(1)} °C`],
    ["Air-conditioning bill", `${num(r.electric)} kWh a year, ${money(r.bill, cur)} (${money(r.bill / area, cur)} per m²)`],
    ["Cooling by the tunnels", `${(100 * share).toFixed(0)}% of it`],
  ];
  const html =
    rows.map(([a, b]) => `<div><b>${a}</b>: ${b}</div>`).join("") +
    `<div style="margin-top:6px;font-size:15px"><b>Saved each year: ${money(r.saved, cur)}</b> (${num(r.savedKWh)} kWh)</div>` +
    r.totals.map((x) => `<div><b>Over ${x.years} years</b>: ${money(x.saved, cur)}</div>`).join("");
  const a = ASSUMPTIONS;
  const assumptions =
    `<ul style="margin:4px 0 0 16px;padding:0">` +
    `<li>Cooling asked for: ${a.intercept} kWh/m² a year plus ${a.perCdh} kWh/m² for every degree-hour above ${a.base} °C, from last year's hourly temperatures.</li>` +
    `<li>Air conditioning makes ${a.cop} kWh of cooling per kWh of electricity.</li>` +
    `<li>The tunnels take over the share of that cooling given by the average cooling of the floors (the Floor data).</li>` +
    `<li>The electricity price is a rough typical commercial price for the region, in its currency, taken to rise ${(100 * a.priceGrowth).toFixed(0)}% a year in the long totals; type your own above.</li>` +
    `<li>Not counted: the cost of building the tunnels, fan energy, maintenance, or hours when the outside air is too hot to cool with.</li></ul>`;
  show({ html, assumptions, currency: cur, price, note: "" });
}

export function mountCost() {
  mountPanel($("cost-panel"), { onPrice: () => { lastKey = ""; } });
  onFrame(frame);
}
