# Flow State: what the software does

**One line:** drop a real-scale Rhino massing onto a real site, and let the sun and the wind *erode* it: the sun grows the form, the wind rounds it, and a solver carves passive-cooling wind tunnels through it that are eroded out of the block over time.

Runs in the browser (plain JavaScript modules, three.js for 3D, no build step). The mass is never edited as a mesh: every change is a *height map*, a *voxel grid* or a *signed-distance cut*.

---

## 1. The pipeline at a glance

```
lat / lon ──► OpenStreetMap context ──► scene (ground, roads, green, buildings)
                     │
  .3dm massing ──► placed on the pin, in metres
                     │
  Open-Meteo wind (a year, hourly, with temperature)  +  solar geometry
                     │
        ┌────────────┼──────────────────┐
     Sun growth   Wind rounding     Wind tunnels
   (adds mass)   (rounds edges)   (carves passive-cooling channels)
        └────────────┴──────────────────┘
        one shared shape; one mode runs at a time, each continues from the last
```

Everything is in **world metres** (x east, y up, z south), pin at the origin, mass base on y = 0.

---

## 2. Site and climate (the inputs)

| Module | What it does | Key logic |
| --- | --- | --- |
| `pipeline.js` | Builds / tears down a site | `generate(lat, lon, radius)`; modules hook in through events (`site:built`, `site:ready`, `site:cleared`, `mass:changed`, `cuts:changed`) |
| `site/osm.js` | Real-world context | `fetchOSM` (Overpass query) → `parseFeatures`: roads, paths, green areas, buildings with heights |
| `site/context.js` | Context geometry | `buildGround`, `buildLines`, `buildGreen`, `buildBuildings` (one shared mesh, buildings rise nearest-first) |
| `site/sun.js` | Sun | `sunPosition(lat, day-of-year, hour)` solar geometry; sun-path arcs, real shadows, day sweep and year run |
| `site/wind.js` | Wind | One year of hourly 10 m wind from Open-Meteo; `windStats` builds the wind rose (direction bins, frequency, mean speed) |
| `site/windFlow.js` | Wind streaks | A steering field (not a fluid solver): a "pressure hill" from the buildings and the mass splits and lifts the streaks, slowing them in the lee |
| `mass/model3dm.js` | The massing | Reads Rhino `.3dm` with self-hosted rhino3dm (WebAssembly, in a worker, with a timeout and a self-diagnosis); converts the model's units to metres; white-model restyle; move / turn gumball and scale handles |

### Warm-season wind (used by the tunnels)
- `warmStats`: every hour counts in proportion to **how far it is above a base temperature** (22 °C, or the year's median if the site never gets that warm). A hot afternoon counts for much more than a mild one; cold months count for nothing.
- `getWarmPeriods(n)`: cuts the warm season into **n consecutive periods that carry equal warmth**, each with its own wind rose and prevailing direction. Starts after the coldest month, so a southern-hemisphere summer stays whole.
- `downwind(from)`: a wind *from* θ° blows toward θ + 180°, as a unit vector.

---

## 3. How erosion plugs together

- **The contract** (`erosion/contract.js`): a *Cut* is `{ id, source, label, bounds, sdf }`, a volume to remove described by a **signed-distance function** (negative inside).
- `erosion/sdf.js`: sphere, capsule, box, union, intersect. `erosion/combine.js`: `registerCutProvider`, `collectCuts`, `notifyCutsChanged`.
- Why distance fields: combining cuts is just taking the minimum, so it never fails on messy meshes, order doesn't matter, and cuts can be toggled or blended instantly.
- Exterior and interior erosion are separate modules (`erosion/exterior`, `erosion/interior`); the interior side is a placeholder for a partner.

---

## 4. Exterior erosion: sun and wind

All three modes work on **one shared shape** (`form.js`), a height map of the mass found by casting rays straight down (`massScan.js`). Only one runs at a time, and each continues from the form the other left.

### Sun growth (`sunGrow.js`)
- The grown mass is a **dilation** of the original: everything within radius *r* of the mass is added, so a roof rises by *r* and a wall moves out by *r*, rounded at the edges. Dilations for a ladder of radii are precomputed once, using a fast **3D distance transform** (Felzenszwalb & Huttenlocher).
- Sunlight sets *r*. While the Sun panel plays a day or the year, every roof cell and every wall the sun can see collects warmth: sun height for roofs, how squarely it faces the wall for walls. **Shadows from the site's buildings and the mass itself are traced.**
- Growth only increases and never grows into a neighbouring building. Colour runs pale yellow → orange with warmth.

### Wind rounding (`windErode.js`)
- The rounded mass is a **morphological opening**: every point a ball of radius *r* can reach from inside is kept. Flat faces stay; only **convex edges and corners** are shaved. The wind never cuts into the mass.
- Wear accumulates per cell from the wind rose: most where a lower neighbour lies **upwind**, some on the flanks, little in the lee. Wear sets *r*, so windward edges round first and furthest. Colour goes white → blue with wear.

### Airflow slice (test view)
- Solves the airflow around the form and shows air speed on a horizontal slice (blue slower, red faster than the open wind).

---

## 5. Wind tunnels: the main computation

Goal: **carve passive-cooling tunnels through the mass that keep out of the rooms**, are placed and shaped by a solver for maximum cooling in the warmest part of the year, and look eroded by the wind.

### 5.1 The voxel mass (`voxelFlow.js` → `createVoxelMass`)
- A 3D grid in world metres, built from the form's height map plus the site's buildings (cell kinds: air, mass, context). About 400,000 cells; horizontal voxels are ~1.4 to 2.1 m depending on the mass size.
- **Storeys are 14 ft (4.27 m).** Vertical layers follow the storeys: one to three thick room layers plus one **thin 0.9 m layer on top, the ceiling void**. That is the only place a tunnel may run, so tunnels never touch the rooms or their circulation.
- The roof (top layer of every column) and the ground layer are never carved.

### 5.2 The airflow solver (`solveFlow`)
- **Potential flow**: velocity = gradient of a potential φ with ∇²φ = 0 in the air. The box boundary holds the free stream (so wind can come from any direction); solid voxels and the ground are walls.
- **Red-black successive over-relaxation** (ω = 1.85), with weights (flow area over distance) so the unequal layer heights are handled exactly. It warm-starts from the previous solution after a small change.
- Air shut in by solid voxels is found by a flood fill from the box faces and gets no flow. Output: speed relative to the open wind in every open voxel.
- Honest limit: potential flow shows **where** air squeezes and speeds up, not turbulence or friction.

### 5.3 Floors and seasons (`tunnels.js`)
- Storeys are grouped in **bands of two**. A band with less than a whole storey of mass is skipped (`usable`).
- **Each band gets its own wind**: a different warm-season period (`getWarmPeriods`), so whichever part of the year it is, one pair of floors or another is being cooled. Each band's airflow is solved for its own direction with the other bands' tunnels in place.

### 5.4 The tunnel shape and the solver's choice
- A tunnel is a tube along the wind with an elliptical cross-section, **wide at the windward mouth, narrow at the throat** (where the same flow squeezes through less room and speeds up), wider again at the exit. Five numbers describe it: `spacing`, `throat`, `mouth`, `exit`, `pos` (throat position). Tunnels in the upper storey sit half a spacing over.
- **Score** = mean cooling × (0.5 + 0.5 × evenness).
  - `cooling(b)`: each tunnel air voxel splats its speed, fading linearly to nothing within **3 m**; each solid voxel takes the strongest value. Coverage is the share of floor volume with cooling ≥ 0.3 (about 2 m from air at the open wind's speed).
  - *Evenness* = weaker floor's coverage ÷ stronger floor's, so the two floors are cooled alike.
- **Volume limit** (slider, default 20%): a shape over the limit scores as no good and isn't solved. That is what gives the width a reason: a few wide tunnels vs many narrow ones.
- **Two-phase search** (`searchStep`): (1) *coarse*: a 12-shape grid solved loosely (60 iterations), giving a quick answer in seconds; (2) *refine*: coordinate descent, varying one number at a time with full solves, up to 3 passes, until nothing improves.
- **Scheduling** (`index.js`): strictly one step per frame (`nextWork`), quick answers for all bands first, then fine search, then stale re-solves. Heavy solves yield to the browser between bursts.

### 5.5 How they are drawn (`tunnelBore.js`, `view.js`)
The solver works on voxels, but **what you see is smooth and analytic**, drawn from the shape numbers:
- **Tube mesh**: 28-point elliptical rings along the axis, with stations bunched at both ends; smooth shading. Walls take the mass's own colour, darker deeper in.
- **Rounded lip**: at each face the opening is flared by 0.6 m, a quarter-circle fillet tangent to the wall, so the opening reads as part of the continuous skin.
- **Erosion animation**: each tunnel starts as a small round dimple in the windward face and bores in with a rounded tip, then breaks out of the leeward face as a small hole that opens up. Tunnels start one after another (random delays). The *Erosion speed* slider sets the pace (2× ≈ half a minute). A new solver answer fills the old tunnels in, then erodes the new ones.
- **Openings in the original model**: a 2-channel 3D texture (one plan per storey: distance from the tunnel axis, and height) is read in patched Lambert shaders, which **discard the mass's own surface exactly inside the tube's cross-section**. Roofs and undersides are never cut.
- **Clearance**: each tunnel keeps **1 m from corners and sides**, checked on the form's height map. A tunnel that fails is moved over, then narrowed, else left out.
- **X-ray mode**: the mass becomes faint and stops hiding anything; only the tunnels stay solid.
- `tunnelCut.js` also exports the voxel tunnels as a signed-distance **cut** for the shared contract.

---

## 6. Key numbers to quote
| | |
| --- | --- |
| Storey height | 14 ft = 4.27 m |
| Tunnel zone | 0.9 m ceiling void, one per storey |
| Floors per tunnel set | 2 (a band), each with its own warm-season period |
| Cooling reach | 3 m |
| Corner clearance | 1 m; opening lip 0.6 m |
| Default volume limit | 20% of a band's volume |
| Quick answer / settle (small test mass) | ~6 s / ~25–35 s |
| Solver | red-black SOR, ω = 1.85, ~400k voxels |

## 7. Honest limits (good to say aloud)
- Potential flow: no turbulence, separation or friction; tunnel air reaches about 1.0–1.3× the open wind.
- Voxels are 1.4–2.1 m, so the solver rounds narrow throats up to a voxel; the drawn tunnels use the exact widths.
- Tunnels are straight, not curved.
- Tunnels left out near corners are still counted by the solver, so the cooling figures can read slightly generous there.
- Wind data is regional reanalysis, not measured on site.
- The interior erosion module is a placeholder.
