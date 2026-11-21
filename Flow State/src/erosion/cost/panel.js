// CONTROLLER (cost savings): the panel in the side panel. `el` is the empty #cost-panel container in index.html. It only shows numbers (index.js works them out),
// and holds one control: the electricity price, which starts at the region's typical price and can be typed over.
export const settings = { price: null }; // null: the region's own price

const $ = (id) => document.getElementById(id);
let mounted = false;

export function mountPanel(el, { onPrice = () => {} } = {}) {
  el.innerHTML = `
    <p class="hint" style="margin-top:0">What the wind tunnels' passive cooling would save against paying for air conditioning, for this building's size, and the climate, currency and electricity price of the site. An estimate: the assumptions are listed below.</p>
    <p id="cost-note" class="hint"></p>
    <div id="cost-result" class="stats"></div>
    <label title="Electricity price for commercial buildings, in the site's currency, per kWh. It starts at a rough typical price for the region: type your own to use it instead.">Electricity price <output id="cost-price-cur"></output> per kWh
      <input type="number" id="cost-price" min="0" step="0.01">
    </label>
    <button type="button" class="tool" id="cost-price-reset" style="width:100%;margin-bottom:8px">Use the region's typical price</button>
    <details id="cost-assumptions" style="margin:0 0 8px">
      <summary style="cursor:pointer;font-weight:600;font-size:13px">Assumptions</summary>
      <div id="cost-assumptions-body" class="hint"></div>
    </details>`;
  mounted = true;
  $("cost-price").addEventListener("input", (e) => {
    const v = e.target.valueAsNumber;
    settings.price = Number.isFinite(v) && v > 0 ? v : null;
    onPrice();
  });
  $("cost-price-reset").addEventListener("click", () => { settings.price = null; onPrice(); });
}

// Shows what index.js worked out: { note, html, assumptions, currency, price (what the field should show) }.
export function show({ note = "", html = "", assumptions = "", currency = "", price = null } = {}) {
  if (!mounted) return;
  const set = (id, key, v) => { const e = $(id); if (e[key] !== v) e[key] = v; };
  set("cost-note", "textContent", note);
  set("cost-result", "innerHTML", html);
  set("cost-assumptions-body", "innerHTML", assumptions);
  set("cost-price-cur", "textContent", currency);
  const field = $("cost-price");
  if (price != null && document.activeElement !== field) field.value = String(Math.round(price * 1000) / 1000);
}
