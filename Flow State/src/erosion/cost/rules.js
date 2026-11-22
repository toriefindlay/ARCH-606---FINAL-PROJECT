// RULES (cost savings): pure functions, no DOM and no three.js. Estimates what the passive cooling saves against running air conditioning, for the building's
// size and the site's climate and electricity price. Every number here is an assumption, shown to the user in the panel: it is an estimate, not a quote.

// Electricity prices for commercial buildings, in each region's own currency per kWh, rough values (they change from year to year and place to place; the panel
// lets the user type their own). The regions are coarse boxes of latitude and longitude, tried in order (the small and specific ones first), so a site near a border
// may land in the neighbour: the panel names the region it chose, and the price can be overridden.
export const REGIONS = [
  { name: "Singapore", box: [1.1, 1.6, 103.6, 104.1], currency: "SGD", price: 0.30 },
  { name: "United Arab Emirates", box: [22.5, 26.2, 51.5, 56.5], currency: "AED", price: 0.30 },
  { name: "United Kingdom", box: [49.8, 59.0, -8.7, 1.9], currency: "GBP", price: 0.28 },
  { name: "Germany", box: [47.3, 55.0, 5.9, 15.1], currency: "EUR", price: 0.25 },
  { name: "France", box: [41.3, 51.1, -5.2, 9.6], currency: "EUR", price: 0.20 },
  { name: "Spain", box: [36.0, 43.8, -9.4, 3.4], currency: "EUR", price: 0.15 },
  { name: "Italy", box: [36.6, 47.1, 6.6, 18.6], currency: "EUR", price: 0.25 },
  { name: "Japan", box: [24.0, 45.6, 122.9, 146.0], currency: "JPY", price: 28 },
  { name: "India", box: [6.7, 35.5, 68.1, 97.4], currency: "INR", price: 9 },
  { name: "China", box: [18.0, 53.6, 73.5, 134.8], currency: "CNY", price: 0.75 },
  { name: "Australia", box: [-43.7, -10.6, 113.1, 153.7], currency: "AUD", price: 0.25 },
  { name: "New Zealand", box: [-47.4, -34.3, 166.4, 178.6], currency: "NZD", price: 0.20 },
  { name: "South Africa", box: [-34.9, -22.1, 16.4, 33.0], currency: "ZAR", price: 2.2 },
  { name: "Brazil", box: [-33.8, 5.3, -74.0, -34.7], currency: "BRL", price: 0.70 },
  { name: "Canada", box: [49.0, 83.2, -141.1, -52.6], currency: "CAD", price: 0.14 },
  { name: "Canada", box: [43.0, 49.0, -80.0, -70.5], currency: "CAD", price: 0.14 }, // (Toronto, Ottawa and Montreal, south of the 49th parallel)
  { name: "Mexico", box: [14.5, 26.0, -118.5, -86.7], currency: "MXN", price: 2.8 },
  { name: "Mexico", box: [26.0, 32.3, -115.0, -107.5], currency: "MXN", price: 2.8 },
  { name: "United States", box: [24.4, 49.5, -125.0, -66.9], currency: "USD", price: 0.13 },
];
const FALLBACK = { name: "Unknown region (US prices used)", currency: "USD", price: 0.15 };

export function regionOf(lat, lon) {
  return REGIONS.find(({ box: [s, n, w, e] }) => lat >= s && lat <= n && lon >= w && lon <= e) ?? FALLBACK;
}

export const ASSUMPTIONS = {
  base: 18, // °C: outside temperatures above this ask for cooling (cooling degree-hours)
  intercept: 6, // kWh of cooling a year per m2 of floor even in a mild climate (people, lights and equipment)
  perCdh: 0.0045, // kWh of cooling per m2 of floor for every degree-hour above the base
  cop: 3.0, // kWh of cooling made per kWh of electricity (a typical commercial air-conditioning plant)
  priceGrowth: 0.02, // a year: how fast the electricity price is taken to rise, for the longer totals
  years: [10, 25],
};

// The floor area of a mass (m2): its floor plates, one a storey, over the part of the footprint that is tall enough to hold each. heightAt(x, z) is the mass's
// height at a point; box is { x0, x1, z0, z1 }.
export function floorArea(heightAt, box, storey, storeys) {
  let total = 0;
  const step = 1;
  for (let z = box.z0 + step / 2; z < box.z1; z += step) {
    for (let x = box.x0 + step / 2; x < box.x1; x += step) {
      const h = heightAt(x, z);
      for (let s = 0; s < storeys; s++) if (h >= (s + 0.5) * storey) total += step * step;
    }
  }
  return total;
}

// The estimate. area: m2 of floor; share: how much of the cooling the tunnels do (0 to 1, the average cooling of the floors); climate: { cdh } from the site's
// temperatures; region: { currency, price }; price: the price to use (per kWh, in the region's currency).
// Returns { thermal, electric, bill, saved, savedKWh, perYear: [{ year, saved }], totals: [{ years, saved }] }.
export function estimate({ area, share, climate, price, a = ASSUMPTIONS }) {
  const thermal = area * (a.intercept + a.perCdh * climate.cdh); // kWh of cooling a year
  const electric = thermal / a.cop; // kWh of electricity for the air conditioning
  const bill = electric * price;
  const savedKWh = electric * share;
  const saved = savedKWh * price;
  const totals = a.years.map((years) => {
    let sum = 0;
    for (let y = 0; y < years; y++) sum += saved * Math.pow(1 + a.priceGrowth, y);
    return { years, saved: sum };
  });
  return { thermal, electric, bill, savedKWh, saved, share, totals };
}
