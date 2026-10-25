import { cacheGet, cachePut, CACHE_TTL } from "../core/storage.js";

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const MAX_BUILDINGS = 6000;
const LEVEL_HEIGHT = 3.2;

export async function fetchOSM(lat, lon, r) {
  const a = `(around:${r},${lat},${lon})`;
  const query = `[out:json][timeout:40];(
    way["highway"]${a};
    way["building"]${a};
    way["leisure"~"^(park|garden|playground|pitch|common|recreation_ground|nature_reserve)$"]${a};
    way["landuse"~"^(grass|forest|meadow|village_green|recreation_ground|cemetery|orchard|allotments)$"]${a};
    way["natural"~"^(wood|water|scrub|grassland|wetland)$"]${a};
    way["waterway"~"^(river|canal|stream)$"]${a};
    relation["type"="multipolygon"]["building"]${a};
    relation["type"="multipolygon"]["leisure"~"^(park|garden|common)$"]${a};
    relation["type"="multipolygon"]["natural"~"^(water|wood)$"]${a};
    relation["type"="multipolygon"]["landuse"~"^(grass|forest|meadow)$"]${a};
  );out geom qt;`;

  // Same site (to ~11 m) and radius within a week: skip the network entirely.
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${r}`;
  const cached = await cacheGet(key);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.json;

  // Ask every server at once and take the first good answer.
  const ctrl = new AbortController();
  const attempts = OVERPASS.map(async (url) => {
    const res = await fetch(url, {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Map server responded ${res.status}`);
    const json = await res.json();
    // An empty reply with a remark is a server-side failure, not an empty site.
    if (json.remark && !json.elements?.length) throw new Error(json.remark);
    return json;
  });

  let json;
  try {
    json = await Promise.any(attempts);
    ctrl.abort();
  } catch (e) {
    throw new Error(`Couldn't reach the map servers (${e.errors?.[0]?.message ?? e.message}). Try again in a moment.`);
  }
  if (!json.elements?.length) throw new Error("No map data found at those coordinates. Check the latitude and longitude.");

  cachePut(key, { time: Date.now(), json });
  return json;
}

const PATH_TYPES = new Set(["footway", "path", "pedestrian", "steps", "cycleway", "bridleway", "corridor", "track"]);
const SKIP_ROADS = new Set(["proposed", "construction", "razed", "abandoned"]);

// Turns raw OSM elements into plain features in site coordinates (Vector2 = east, north):
//   roads/paths [{pts, kind}], green [{outer, holes, kind} | {line, kind}], buildings [{outer, holes, height}]
export function parseFeatures(data, project) {
  const out = { roads: [], paths: [], green: [], buildings: [], counts: {} };
  const toPts = (geom) => geom.map((g) => project(g.lat, g.lon));
  const isClosed = (g) => g.length > 3 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;

  // Returns [{outer: Vector2[], holes: Vector2[][]}]
  const polygonsOf = (el) => {
    if (el.type === "way") return el.geometry && isClosed(el.geometry) ? [{ outer: toPts(el.geometry), holes: [] }] : [];
    const outers = (el.members || []).filter((m) => m.role !== "inner" && m.geometry && isClosed(m.geometry));
    const inners = (el.members || []).filter((m) => m.role === "inner" && m.geometry && isClosed(m.geometry));
    return outers.map((o) => ({ outer: toPts(o.geometry), holes: inners.map((i) => toPts(i.geometry)) }));
  };

  for (const el of data.elements) {
    const t = el.tags || {};

    if (t.highway && el.type === "way" && !SKIP_ROADS.has(t.highway) && el.geometry) {
      (PATH_TYPES.has(t.highway) ? out.paths : out.roads).push({ pts: toPts(el.geometry), kind: t.highway });
    } else if (t.waterway && el.geometry) {
      out.green.push({ line: toPts(el.geometry), kind: "water" });
    } else if (t.building || t["building:part"]) {
      for (const poly of polygonsOf(el)) out.buildings.push({ ...poly, height: buildingHeight(t, poly.outer) });
    } else if (t.leisure || t.landuse || t.natural) {
      const kind = t.natural === "water" || t.natural === "wetland" ? "water" : "green";
      for (const poly of polygonsOf(el)) out.green.push({ ...poly, kind });
    }
  }

  // Cap the building count, keeping the buildings nearest the site.
  const dist = (b) => b.outer.reduce((s, p) => s + p.length(), 0) / b.outer.length;
  out.buildings.sort((a, b) => dist(a) - dist(b));
  out.buildings = out.buildings.slice(0, MAX_BUILDINGS);

  out.counts = {
    roads: out.roads.length,
    paths: out.paths.length,
    green: out.green.length,
    buildings: out.buildings.length,
  };
  return out;
}

function buildingHeight(t, outer) {
  const h = parseFloat(t.height ?? t["building:height"]);
  if (h > 0) return h;
  const levels = parseFloat(t["building:levels"]);
  if (levels > 0) return levels * LEVEL_HEIGHT + (t["roof:levels"] ? 1.5 : 0);
  // No tag: deterministic pseudo-random 2-4 storeys so reloads match.
  const seed = Math.abs(Math.sin(outer[0].x * 12.9898 + outer[0].y * 78.233) * 43758.5453) % 1;
  return (2 + Math.floor(seed * 3)) * LEVEL_HEIGHT;
}
