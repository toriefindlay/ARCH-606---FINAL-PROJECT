# Flow State: computational strategies

A guide to the main algorithms behind each feature, and why each was chosen. Everything runs in the browser (plain JavaScript modules + three.js), in **world metres** (x east, y up, z south, site pin at the origin, mass base on y = 0).

**The big idea:** the mass is never edited as a mesh. Every change is made on a *grid*: a **height map** (sun, wind rounding), a **voxel grid** (tunnels and airflow) or a **signed-distance field** (cuts, skin). A mesh is extracted only at the end, for display. Grids never fail on messy geometry, combine with simple operations, and can be re-run as often as the inputs change.

| Feature | Representation | Core method |
| --- | --- | --- |
| Site context | vector footprints | OpenStreetMap (Overpass) to extruded geometry |
| Climate | hourly time series | temperature-weighted wind rose; warm-season periods |
| Sun | solar geometry + ray tracing | sun position; shadow rays |
| Shared form | height map | rays cast straight down through the Rhino mesh |
| Sun growth | height map | **dilation** via 3D distance transform |
| Wind rounding | height map | **morphological opening** via 3D distance transform |
| Airflow | voxel grid | **potential flow**, red-black SOR |
| Wind tunnels | graph of tubes | **resistor-network flow**, Murray's law, growth, **simulated annealing** |
| Cooling score | voxel field | distance-faded air speed, coverage, evenness |
| Tunnel and skin surfaces | implicit field | **SDF**, Gaussian blur, smooth max, **marching cubes** |
| Wind particles | velocity field | RK2 advection, backward tracing from tunnel air |
| Combining cuts | SDF | union = `min` (the exterior/interior contract) |

---

## 1. Site and climate inputs

### Site context (`site/osm.js`, `site/context.js`)
- One Overpass query per site returns roads, paths, green areas and buildings. `parseFeatures` turns them into 2D rings (east, north) with heights.
- Buildings are drawn as one shared mesh, so hundreds of footprints cost a single draw call.
- For the wind and shadow work the buildings are also **rasterised to a height map** (`windFlow.js: rasterBuildings`, even-odd point-in-polygon per cell). That is how the solvers "see" the neighbourhood.

### Wind data (`site/wind.js`)
- A year of **hourly** 10 m wind speed, direction and temperature from Open-Meteo reanalysis (regional, not measured on site).
- **Wind rose** (`windStats`): 16 direction bins of 22.5 degrees, each with frequency and mean speed. Calm hours (< 0.5 m/s) are counted separately.
- **Warm-season rose** (`warmStats`): each hour is **weighted by how far it is above a base temperature** (22 °C, or the year's median if the site never gets that warm). A hot afternoon counts for much more than a mild one, and cold months count for nothing. This gives the wind that matters for passive cooling instead of the annual average.
- **Warm periods** (`getWarmPeriods(n)`): the warm months are cut into `n` consecutive periods that carry **equal total warmth**, each with its own rose and prevailing direction. The year starts after the coldest month, so a southern-hemisphere summer that straddles New Year stays whole.
- Convention: direction is where the wind comes *from*; `downwind(from)` converts to a unit vector `[-sin θ, cos θ]` in (x, z).

### Sun (`site/sun.js`)
- `sunPosition(lat, day-of-year, hour)` is standard solar geometry (declination, hour angle, altitude and azimuth). The sun-path arcs, marker and shadows all come from it, and the Sun panel steps time through a day or the year.

### The wind streaks (`site/windFlow.js`), the cheap layer
- Not a fluid solver but a **steering field**. The buildings and mass become a height map, are grown by a radius (running **max** filter) and softened (box blurs) into a "pressure hill".
- A streak below the hill's height is turned sideways where it heads into a face (so it splits and slides along walls), and lifted near roof height. Behind the mass the speed is cut by sampling upwind for shelter (the wake).
- Cheap enough for ~900 animated streaks. It cannot pass *through* an overhang, which is why the tunnels use the voxel solver below.

---

## 2. The shared form: a height map (`massScan.js`, `form.js`)

- The imported Rhino mesh is scanned by **casting rays straight down** on a regular grid. Each cell stores the height of the mass there. The scanned mass's own mesh does not shape the erosion afterwards.
- A height map keeps the sun and wind rounding fast and simple: both are 2D filters over a grid. The limit is that it cannot represent an overhang. That is why the tunnels use a separate 3D voxel version of the form (section 4).
- Sun growth and wind rounding each start from whatever shape the other left, so the mass is always **one form**. Only one runs at a time.

---

## 3. Sun growth and wind rounding

Both use **distance transforms**, which make morphological operations cheap at any radius.

### 3D distance transform
- The Felzenszwalb and Huttenlocher algorithm gives the exact Euclidean distance to the nearest solid cell in linear time per axis (a lower-envelope-of-parabolas pass along x, then y, then z).
- Thresholding that distance at *r* gives a **dilation** (all points within r of the mass). Thresholding the distance of the *complement* gives an **erosion**, and an erosion followed by a dilation gives an **opening**.

### Sun growth (`sunGrow.js`): dilation
- The grown mass is a dilation of the original by radius *r*. A roof rises by r, a wall moves out by r, and the edges come out rounded. Dilations for a ladder of radii are **precomputed once per mass**, so the animation just looks up a level.
- **Sunlight sets r.** As the Sun panel advances time, every roof cell and every sun-facing wall collects warmth: the sun's height for roofs, how squarely the sun faces the wall for walls. **Shadows are traced** from the site's buildings and from the mass itself, so a shaded wall collects nothing.
- Warmer roofs grow higher and warmer walls grow further out. Growth only increases, never grows into a neighbouring building, and the ground does not swell.

### Wind rounding (`windErode.js`): opening
- The rounded mass is an **opening**: keep every point a ball of radius r can reach from inside. Flat faces stay put, and only **convex edges and corners** are shaved. It never cuts into the mass, and the ground counts as solid so wall feet aren't rounded.
- **Wear** accumulates per surface cell from the wind rose: most where a lower neighbour lies **upwind**, some on the flanks, little in the lee. Wear sets the local r, so windward edges round first and furthest. Wear only grows.

---

## 4. The airflow solver (`voxelFlow.js`)

### The voxel mass
- The height map and the site's buildings are turned into a 3D grid of **air / mass / context** voxels (up to ~250,000 cells for the test view, 500,000 for the tunnels), padded with free air so the stream can be held at the box edge.
- With a storey height given, layers are cut so **every floor lies on a layer edge** (e.g. 5 layers per storey), and layer heights need not be equal.

### Potential flow
- The air is treated as **incompressible and irrotational**: velocity = gradient of a potential φ, with ∇²φ = 0 in the air.
- **Boundary conditions:** the four sides and the top of the box hold the free-stream potential (`ux·x + uz·z`), so the wind can come from any direction. Solid voxels and the ground are walls (no flow through them). Air squeezes round or through obstructions and speeds up in the constriction, which is the effect the tunnels rely on.
- **Solver:** **red-black successive over-relaxation** (ω = 1.85). A checkerboard split lets each half be updated in place. Each cell moves towards the weighted mean of its *open* neighbours (a missing, solid neighbour is a wall). The weights are flow-area over distance, so unequal layer heights are handled correctly.
- **Reachable air:** a **flood fill** from the box faces marks the air the wind can actually reach. Sealed pockets get no flow.
- **Warm start:** a previous solution for the same direction seeds the next solve, so small changes re-converge in a few passes.
- **Velocity** is the central-difference gradient of φ at each open voxel, with the same wall rule. The output is speed relative to the open wind (1 = as fast as far away).
- **Why potential flow:** it is fast, stable and smooth, and it correctly shows *where* air accelerates. It has no turbulence, separation, wake or friction, so it is a judge of where, not of exact speed.

---

## 5. The wind tunnels (`tunnels.js`): a growing vein network

The tunnels are **not** drawn by hand or fixed shapes. They are a graph of nodes and tubes whose placement and width come only from the flow through them.

### 5.1 Wall pressure (`wallPressure`)
The wind loads the mass's outer walls with a pressure (in units of the wind's dynamic pressure), from the wall's orientation `cd` (−1 windward, +1 leeward):

`p = (windward ? −0.8·cd : −0.5·cd) − 0.3·(1 − cd²)`, with extra suction near corners on lee and side walls, all scaled by `0.75 + 0.5·(height / roof height)` because wind is faster higher up.

So windward walls are high pressure, leeward and side walls are low, and the air wants to flow through the mass from one to the other.

### 5.2 Flow through the network (`solvePressure`)
- The network is solved like an **electrical network of resistors**. Walls where a tube ends are held at their wall pressure, the interior nodes find their own pressures, and air flows from high to low.
- **Turbulent pipe law:** pressure lost along a tube = K · dynamic pressure, with K = end losses (junction 0.8, slight bend 0.05) + friction (0.04 per diameter of length). The air speed is `v = sqrt(Δp / K)` and the flow is `area × v`.
- Because the loss is nonlinear in speed, it is solved by **Picard iteration**. The conductance of each tube is `C / sqrt(|Δp|)`, and each pass solves a *linear* network with a **preconditioned conjugate-gradient** solve. It does 2 passes while growing and 3 when settled.
- **Stack effect** (warm-air rise): the potential of the indoor air is pressure plus weight, so every wall's pressure falls with height by a `buoyancy` term (from the user's indoor-warmer-by value). This draws air in low and out high, and matters most in weak wind and tall masses.

### 5.3 Growth (round by round)
- **Radius from flow (Murray's law):** a tube's radius grows with the air it carries, `r ∝ flow^0.22` (Murray's law says 1/3, but that makes parallel tubes fight until one is left, so a smaller exponent lets them share). Wide trunks split into thinner branches, and a tube carrying almost nothing shrinks and is removed. All radii are scaled together to hold the **volume limit**.
- **Trunks first:** straight channels start at windward walls, spaced about 9 m apart (twice a trunk's cooling reach), each heading for a leeward or side wall. This is done on every storey so no floor is missed.
- **Branches:** sprout from the tubes carrying the most air, towards parts of the floor that no tunnel cools yet. A branch is steered by a mix of its current heading, its target, the uncooled floor, and a little wander. It bends away from occupied spaces and stays inside the mass.
- **Joining:** where two tubes at different pressures come near, a link is made. If air flows through it, it stays and widens, which is how tunnels loop and split round a space.
- **Constraints:** the roof, the ground layer, the corners of the mass (1 m clearance) and the occupied spaces (the interior team's spheres) are never touched. A tube's axis is only allowed where it leaves roof above and floor below.
- **Spatial hash** (4 m cells) speeds up all the "what is near" lookups.

### 5.4 Tuning by simulated annealing
- After growth, the network is **tuned against the cooling it actually gives**, for **several winds at once**: the main directions of the warm-season rose (up to 4), each weighted by its share of hours times its speed. This stops a network that only suits the prevailing wind from winning.
- Each trial makes a small change: move volume from a low-use tube to a high-use one, nudge a junction, move an opening along the facade (or re-aim it at another wall), add a link between tubes at different pressures, or remove a link. Each trial re-solves the flow and re-scores.
- **Annealing:** a worse result is sometimes accepted, less often as the time runs out (T0 = 0.004 in score units), so the search can leave a local best. The best network seen is the one kept. Any change that would take the volume more than 2% over where tuning began is refused.
- Scoring while tuning looks at every 2nd voxel each way (1/8 of the voxels) for speed, and warm-starts each wind from its last pressures.

### 5.5 Cooling score (`coolField`, `coolStats`, `scoreOf`)
1. **Cooling field.** Every tube with air speed `v0` (relative to the open wind) cools the voxels near it. A voxel at distance `d` from the tube's centreline gets `v0 · (1 − d / reach)`, fading linearly to nothing at `reach`. Each voxel takes the **strongest** value of any tube (not the sum).
2. **Reach depends on width:** `reach = 3 m × clamp(r / 0.7, 0.5, 1.8)`. A wider tube moves more air and cools further, a thin one less far. This is what makes the search prefer a few wide tunnels over many thin ones of the same volume.
3. **Per-storey coverage.** Only solid (floor) voxels count. Each counts `min(1, cooling / 0.3)`, weighted by layer thickness. 0.3 is about 2 m from air moving at the open wind's speed, and slower air still counts in proportion. Coverage = the weighted share of the storey that is cooled.
4. **Average cooling** per storey is `min(cooling, 1)` averaged the same way, and **mean** is the whole-mass average (capped at 1.5).
5. **Evenness** = weakest storey's coverage ÷ strongest storey's, so a design that cools one floor well and ignores another is penalised.
6. **Score** = `covered × (0.5 + 0.5 × evenness)`, in 0 to 1. For several winds, the score is the weighted sum of each wind's score.

The *Cooling data* x-ray layer (`coolingView.js`) draws the same cooling field as a floor plan per storey, 0 to 50% (red = little, blue = fully cooled at 30% and above).

### 5.6 The real airflow through the finished tunnels
When growth and tuning end, the network is **cut into the voxel grid**, and `solveFlow` (section 4) solves the true potential flow through the carved mass. The "tunnel air" figure in the Floor data table (× the open wind) and the particle field come from this solve. The vein-network model is used to *design*, the voxel solve to *report*.

---

## 6. Surfaces: SDFs, implicit fields and marching cubes

### The SDF cut contract (`erosion/contract.js`, `sdf.js`, `combine.js`)
- A **Cut** is `{ id, source, label, bounds, sdf }`, a volume to remove given as a **signed distance** (negative inside, in metres). Primitives: sphere, capsule, box, union, intersect.
- **Why SDFs:** combining cuts is just `min`, so it never fails on messy meshes, order doesn't matter, cuts can be toggled or blended instantly, and exterior and interior teams can contribute independently. The cost is that no surface exists until one is extracted (marching cubes), and sharp edges round slightly at coarse resolution.
- `tunnelCut.js` exports the voxel tunnels as an SDF with **two distance transforms** (distance to the nearest tunnel voxel from outside, to the nearest non-tunnel voxel from inside).

### Tunnel walls (`tunnelMesh.js`)
- The tubes are stamped into a **smooth field on a fine grid** (1 inside a tunnel, falling to 0 over a few decimetres). The wall is the **iso-level** of that field, extracted by **marching cubes**, with normals from the field gradient. Tubes of any radius that meet blend into one smooth passage.
- The same field goes to the shader, which **discards the mass's own surface** wherever the field is above the iso-level, so where a tunnel reaches a wall it leaves a clean opening in the original model.

### Softened skin (`skinShell.js`)
Once the tunnels are done, the outside becomes **one smooth implicit surface**:
1. The mass's signed distance, **Gaussian-blurred** (blurring a distance field leaves flat walls in place and rounds every convex corner and edge).
2. **Pushed in or out along the walls** by a shift that depends on the distance to the nearest opening: a soft dish at an opening, a bulge between, smoothly blended. Some openings get a broad receding pad, and a slow large wave runs over the walls so nothing is uniform.
3. The tunnels removed with a **smooth max** of the skin and the tunnel interior, which rounds the rim of each opening like a window reveal.

The result is meshed with marching cubes. It changes only the outside look. Tunnels and cooling stay computed on the mass as placed.

### Never freezing the page (`marching.js`)
The heavy loops (stamping, blurring, meshing) are written as **JavaScript generators** that yield every few milliseconds. The caller advances one per frame, so a redraw spreads over several frames instead of freezing one. Solvers likewise `await tick()` between bursts.

---

## 7. Wind particles (`windParticles.js`)

- **Several massings** (`mass/model3dm.js`): all imported massings sit under one group, so the scan, erosion and solvers treat them as one mass with open air in the gaps. The form's grid covers all of them, so massings placed far apart get a coarser grid.
- **Surrounding particles:** 18,000 extra particles, with or without tunnels, are born evenly over a field laid along the wind that reaches 18 to 32 m past the outermost massing on both sides, and further upwind and downwind. They live only a few seconds so they stay evenly spread. The field is limited to the airflow's solving box.
- **Without tunnels:** the potential flow is solved on a voxel copy of the massings and the site's buildings. Half the particles are seeded in **gap air** (mass within 30 m on two opposite sides) and traced back upwind. This makes the streams in the gaps denser than the real air flow would, so compare speeds by colour, not by particle density. The rest of this section applies to both cases.

- **Field:** the solved tunnel airflow, with the velocities **blurred over open neighbours** (3×3×3) to remove voxel stair-steps. It is sampled by **trilinear interpolation** between open voxel centres (solid corners are excluded and the weights renormalised), with uneven layer heights handled.
- **Advection:** **midpoint (RK2)** steps, with the step count chosen so a particle never moves more than half a voxel. A particle that leaves open air or the box dies and respawns.
- **Fluid look:** short trails recorded at fixed time intervals, fade in and out at birth and death, and colour by speed ratio (blue slower, red faster than the open wind).
- **Dense streams through the tunnels:** streamlines follow physics, so most air goes round the mass. To show the tunnels, **85% of the particles are seeded in the tunnel air** (open voxels with solid on at least 3 sides, chosen in proportion to their air speed) and **traced backwards** along the flow to where they came from, then released from there. Every opening gets a dense stream feeding it.
- **Seasons:** each warm period's direction solves its own flow on the same carved voxels (cached), and the velocity fields **cross-fade** over about 1.6 s so particles turn smoothly. The period's mean speed scales the particle speed.

---

## 8. Interior erosion and spaces (`interior/`)

- Occupied spaces are user-placed **spheres** `{ kind, x, y, z, r }`. Overlapping spheres make one connected space.
- For now their only effect is to **keep the tunnels out**: a tube's axis must stay at least `r + tube radius + 0.3 m` from every sphere, and growing branches bend away from them. Changes are applied once the spheres have stopped moving for 0.8 s, so dragging doesn't restart the tunnels every step.
- `interior/rules.js` (the interior cuts) is still a placeholder.

---

### Circulation with several structures (`circulation/structures.js`)
- The footprint is split into its **separate pieces** (massings that touch count as one building), and each is planned by `rules.js` as if it stood alone, so every building has its own stairs, main cores, entrances and limits. In main-cores mode the tunnels are moved for one structure after another. All structures use the same hallway axes as the tunnels.

## 9. Where it can't be trusted (honest limits)

- **Potential flow:** no turbulence, separation or friction. It shows where air accelerates, not true speeds. Tunnel speeds are relative to the open wind.
- **Voxel resolution** (about 1 to 4 m): thin throats round up to a voxel. The drawn tunnels use the exact radii.
- **The wall-pressure model** is a simplified analytic estimate, not a CFD result.
- **Wind data** is regional reanalysis at 10 m, not measured on site. One year of data is used.
- **Height-map form:** the sun and wind rounding cannot represent overhangs, and the 3D tunnels are built on a voxel copy of it.
- **Cooling** is a proxy (distance-faded air speed), not a thermal comfort or energy simulation.
