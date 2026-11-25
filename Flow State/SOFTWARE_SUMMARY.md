# Flow State: computational strategies

A guide to the main algorithms behind each feature, and why each was chosen. Everything runs in the browser (plain JavaScript modules + three.js), in **world metres** (x east, y up, z south, site pin at the origin, mass base on y = 0).

*Last updated 24 Nov 2026.*

**The big idea:** the imported mesh is never edited. Changes are worked out on *grids*: a **height map** (the massings as placed), a **voxel grid** (tunnels and airflow) and a **signed-distance field** (cuts, skin). Meshes are made only at the end, for display. Grids cope with messy geometry, combine with simple operations, and can be re-run as often as the inputs change.

| Feature | Representation | Core method |
| --- | --- | --- |
| Site context | vector footprints | OpenStreetMap (Overpass) to extruded geometry |
| Climate | hourly time series | temperature-weighted wind rose; warm-season periods |
| Sun | solar geometry + ray tracing | sun position; shadow rays |
| Massings and shared form | height map | rays cast straight down through the Rhino meshes |
| Airflow | voxel grid | **potential flow**, red-black SOR |
| Wind tunnels | graph of tubes | **rule-based ductwork**, grown round by round against the measured airflow |
| Cooling score | voxel field | distance-faded air speed, coverage, evenness |
| Tunnel and skin surfaces | implicit field | **SDF**, **marching cubes** |
| Wind particles | velocity field | RK2 advection, backward tracing |
| Circulation | 2D grids per floor | clearance maps, routed hallways, stair placement |
| Facades | triangle meshes on wall grids | surface reading, then panel patterns laid on it |
| Floor plans | SVG | slices of the massing and the tunnel and circulation data |
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

## 2. Massings and the shared form (`mass/model3dm.js`, `massScan.js`, `form.js`)

- Any number of Rhino `.3dm` massings can be imported, duplicated, moved, turned and scaled. One is selected at a time.
- All massings sit under **one group**, so the scan, erosion and solvers treat them as one mass with open air in the gaps. The grid covers all of them, so massings placed far apart get a **coarser grid**.
- The meshes are scanned by **casting rays straight down** on a regular grid. Each cell stores the height of the mass there.
- A height map is simple and fast. The limit is that it **cannot represent an overhang**. The tunnels use a separate 3D voxel version of the form (section 4).
- The earlier **sun growth** and **wind rounding** tools have been removed. The form is now the massings as placed.

---

## 3. Distance transforms (`distance.js`)

- The Felzenszwalb and Huttenlocher algorithm gives the exact Euclidean distance to the nearest solid cell in linear time per axis (a lower-envelope-of-parabolas pass along x, then y, then z).
- It turns the carved tunnels into a signed-distance field and gives the mass's signed distance for the skin.

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

## 5. The wind tunnels (`tunnels.js`): ductwork tested against the airflow

The tunnels are a graph of nodes and tubes laid out **by rules**, like building ductwork, and added where the **simulated air** shows the floors are least cooled. This is the method that runs (`DUCTS = true`).

### 5.1 Wall pressure (`wallPressure`)
Used to place openings and in the alternative method (5.5). The wind loads the mass's outer walls with a pressure (in units of the wind's dynamic pressure), from the wall's orientation `cd` (−1 windward, +1 leeward):

`p = (windward ? −0.8·cd : −0.5·cd) − 0.3·(1 − cd²)`, with extra suction near corners on lee and side walls, all scaled by `0.75 + 0.5·(height / roof height)` because wind is faster higher up.

So windward walls are high pressure, leeward and side walls are low, and the air wants to flow through the mass from one to the other.

### 5.2 Growing the ducts
- **Own network on every floor**, at mid-storey (storeys are 14 ft, about 4.27 m), drawn on the **building's two axes** (read from the directions its walls face). The main axis is the one closest to the wind.
- **Only 0, 45 and 90 degree angles.**
- **Seeding:** straight **trunks** run wall to wall along the main axis about every 14 m, offset on alternate floors. **Cross branches** open the side walls, about every 12 m, where a wind blows on them.
- **Rounds:** each round carves the network into the voxels, solves the real potential flow (section 4) and gives every tube the **air speed measured along it**. Each floor still short of the goal gets up to 14 additions where it is cooled least. These are tried as **rungs** (45 degree links between runs), **cross branches**, **branches**, **risers** (vertical links between floors) or new trunks. Near an occupied space, a riser is tried early.
- **Sizes:** trunks 1.0 m radius, branches 0.8 m, twigs 0.7 m, each varied by 0.75 to 1.35 times so the openings differ.
- **Goal:** every floor has at least **10% average cooling** and at least **95% coverage**.
- **Stops** at the goal, 120 rounds, the time limit (25 minutes), the **40% volume limit**, or 5 rounds in which nothing more fits. The round that meets the goal, or otherwise the best-scoring one, is kept, and stubs that end in solid are removed.
- **Constraints:** roofs, the ground layer, the corners of the mass and occupied spaces are kept clear, and tubes keep their distance from one another (2.25 m between centrelines).

### 5.3 Cooling score (`coolField`, `coolStats`, `scoreOf`)
1. **Cooling field.** Every tube with air speed `v0` (relative to the open wind) cools the voxels near it. A voxel at distance `d` from the tube's centreline gets `v0 · (1 − d / reach)`, fading linearly to nothing at `reach`. Each voxel takes the **strongest** value of any tube (not the sum).
2. **Reach depends on width:** `reach = 3 m × clamp(r / 0.7, 0.5, 1.8)`. A wider tube moves more air and cools further, a thin one less far.
3. **Per-storey coverage.** Only solid (floor) voxels count. Each counts `min(1, cooling / 0.3)`, weighted by layer thickness. 0.3 is about 2 m from air moving at the open wind's speed, and slower air still counts in proportion. Coverage = the weighted share of the storey that is cooled.
4. **Average cooling** per storey is `min(cooling, 1)` averaged the same way, and **mean** is the whole-mass average (capped at 1.5).
5. **Evenness** = weakest storey's coverage ÷ strongest storey's, so a design that cools one floor well and ignores another is penalised.
6. **Score** = `covered × (0.5 + 0.5 × evenness)`, in 0 to 1. The ducts are judged on the airflow of the main wind.

The *Cooling data* x-ray layer (`coolingView.js`) draws the same cooling field as a floor plan per storey, 0 to 50% (red = little, blue = fully cooled at 30% and above).

### 5.4 What is reported
The finished network is carved into the voxel grid and `solveFlow` solves the potential flow through it. The "tunnel air" figure in the Floor data table (times the open wind) and the particle field come from this solve.

### 5.5 The alternative method (in the code, switched off)
With `DUCTS = false`, a **free-growing vein network** is used instead: a resistor-network flow solve with a turbulent pipe law and a stack-effect (warm-air rise) term, tube radii following a relaxed Murray's law, then **simulated annealing** over several winds. **None of this runs at present.** As a result:
- the fixed 10 K warm-air rise **does not affect** the current tunnels;
- **Tune for all main wind directions** does not tune or score for several winds. Its wind set only affects which walls may take cross openings.

---

## 6. Surfaces: SDFs, implicit fields and marching cubes

### The SDF cut contract (`erosion/contract.js`, `sdf.js`, `combine.js`)
- A **Cut** is `{ id, source, label, bounds, sdf }`, a volume to remove given as a **signed distance** (negative inside, in metres). Primitives: sphere, capsule, box, union, intersect.
- **Why SDFs:** combining cuts is just `min`, so it never fails on messy meshes, order doesn't matter, cuts can be toggled or blended instantly, and exterior and interior teams can contribute independently. The cost is that no surface exists until one is extracted (marching cubes), and sharp edges round slightly at coarse resolution.
- `tunnelCut.js` exports the voxel tunnels as an SDF with **two distance transforms** (distance to the nearest tunnel voxel from outside, to the nearest non-tunnel voxel from inside).

### Tunnel walls (`tunnelMesh.js`)
- The tubes are stamped into a **smooth field on a fine grid** (1 inside a tunnel, falling to 0 over a few decimetres). The wall is the **iso-level** of that field, extracted by **marching cubes**, with normals from the field gradient. Tubes of any radius that meet blend into one smooth passage.
- The same field goes to the shader, which **discards the mass's own surface** wherever the field is above the iso-level, so where a tunnel reaches a wall it leaves a clean opening in the original model.
- On **rounded massings** (section 7) openings are discarded from surfaces of any slope; otherwise roofs and undersides are never opened.

### The skin (`skinShell.js`)
Once the tunnels are done on massings that are not rounded, the outside is drawn as **one surface**:
1. The mass's signed distance (flat walls, sharp corners).
2. The tunnels removed with a **hard cut**. Each opening gets either a round, flared 30 degree reveal, or, with the Triangular or Organic facade, a **straight-sided niche 1 m deep** in a shape from the pattern, with the round tube running on behind.
3. The circulation's hallways cut out where they reach the face.

The mass counts as solid below ground **only under its own footprint**, and the walls run just into the ground, so there is no lip around the base. The mesh comes from marching cubes. Facades can set the colour of the openings and tunnels. Only the look changes: tunnels and cooling are computed on the mass as placed.

The former **soften the skin** control and its code have been removed. The skin is always the crisp version.

### Never freezing the page (`marching.js`)
The heavy loops (stamping, blurring, meshing) are written as **JavaScript generators** that yield every few milliseconds. The caller advances one per frame, so a redraw spreads over several frames instead of freezing one. Solvers likewise `await tick()` between bursts.

---

## 7. Massing shapes: how surfaces are chosen

| Shape | Surface shown | Facade placement |
| --- | --- | --- |
| **Simple box** | the skin (section 6) | four footprint walls |
| **Stepped** (steps, wings, towers, notches, overlapping blocks) | the skin | every visible upright face (`faceWalls.js`) |
| **Rounded** (domes, shells) | the **original surface** with openings cut into it | five views (`curvedWalls.js`) |

- A massing is **rounded** if more than 40% of its surface is neither near upright nor near flat. The skin would turn its curves into steps. If **any** massing on a site is rounded, all of them are treated this way, with no flared reveals, circulation windows or pattern-shaped openings.
- **Stepped:** faces are found on the massing's own mesh, hidden parts removed, and cut into rectangles the face fully covers. Panels are trimmed to them and lean out at outward corners. Faces under about 0.7 m are left bare, and slanted faces may be missed.
- **Rounded:** the surface is read from the four sides and from above. Each view covers what faces it most, and panels stand out along the surface normal.

---

## 8. Wind particles (`windParticles.js`)

- **With or without tunnels.** Without them, the potential flow is solved on a voxel copy of the massings and the site's buildings, and half the stream particles are seeded in **gap air** (mass within 30 m on two opposite sides) and traced back upwind.
- **Surrounding particles:** besides the 36,000 stream particles, **18,000** more are spread over a field laid along the wind, reaching 18 to 32 m past the outermost massing on both sides and further upwind and downwind. Short lives keep them evenly spread. The field is limited to the solving box.
- **Start mid-flow:** on the first frame each particle is carried to a random point in its life, with its trail already drawn.
- **Reading them:** extra particles are seeded in gaps and tunnels, so compare **speed by colour**, not by how dense the particles are.
- **Field:** the solved tunnel airflow, with the velocities **blurred over open neighbours** (3×3×3) to remove voxel stair-steps. It is sampled by **trilinear interpolation** between open voxel centres (solid corners are excluded and the weights renormalised), with uneven layer heights handled.
- **Advection:** **midpoint (RK2)** steps, with the step count chosen so a particle never moves more than half a voxel. A particle that leaves open air or the box dies and respawns.
- **Fluid look:** short trails recorded at fixed time intervals, fade in and out at birth and death, and colour by speed ratio (blue slower, red faster than the open wind).
- **Dense streams through the tunnels:** streamlines follow physics, so most air goes round the mass. To show the tunnels, **85% of the particles are seeded in the tunnel air** (open voxels with solid on at least 3 sides, chosen in proportion to their air speed) and **traced backwards** along the flow to where they came from, then released from there. Every opening gets a dense stream feeding it.
- **Seasons:** each warm period's direction solves its own flow on the same carved voxels (cached), and the velocity fields **cross-fade** over about 1.6 s so particles turn smoothly. The period's mean speed scales the particle speed.

---

## 9. Interior spaces (`interior/`)

- Occupied spaces are user-placed **spheres** `{ kind, x, y, z, r }`. Overlapping spheres make one connected space.
- For now their only effect is to **keep the tunnels out**. Changes are applied once the spheres have stopped moving for 0.8 s, so dragging does not restart the tunnels at every step.
- `interior/rules.js` (the interior cuts) is still a placeholder.

---

## 10. Circulation (`circulation/`)

- Planned once the tunnels are finished (`rules.js`): each floor is a grid along the tunnels' axes, hallways run where they are clear of tunnels and spaces, and stairs and lifts link floors from ground-floor entrances. **Scattered** mode leaves the tunnels untouched. **Main cores** mode moves tunnels around the cores (`reroute.js`).
- **Several structures** (`structures.js`): the footprint is split into separate pieces (touching massings count as one). Each is planned as its own building, with its own stairs, cores, entrances and limits. In main-cores mode the tunnels are moved for one structure after another. All use the tunnels' hallway axes.

---

## 11. Facades (`facades/`)

- Real **protruding triangle meshes** over a procedural wall texture (`shader.js`). They are for appearance only and have **no effect on tunnels, wind, sun or cooling**. Every site starts with **None** unless it was saved with a facade.

| Facade | Panels | Tunnel openings | Size range |
| --- | --- | --- | --- |
| **Triangular** | folded shades on a triangle grid | pattern-shaped niche | 60 to 400% |
| **Organic** | thick flowing web | an enlarged web cell, niche | 60 to 200% |
| **Cubic** | white stepped blocks | round, white | 60 to 200% |
| **Protruding fins** | rippling upright blades | round, navy | 60 to 200% |
| **Hexagonal** | hooded honeycomb | round, navy | 60 to 200% |

- **Wall reading** (`walls.js`, `plainWalls.js`): on simple boxes, the outside surface is read into a **depth grid** for each of four sides. Panels are designed flat and each point is set on the surface found there.
- **Triangular:** tiles are one size across the wall. Those over an opening are widest open, and they close with distance. The face is bridged across openings so tiles are not dropped. Walls are joined at corners. The recess behind uses a finer division of the same grid. At large sizes on busy walls, most tiles are over or near an opening, so most stay open.
- **Organic:** one web wraps all round each simple-box massing, with the two walls at each corner joined on a shared edge. On stepped shapes each face is bordered separately.
- **Openings:** the niche shapes in the table apply to the skin. Rounded massings keep plain cut openings. Cubic's block height stops growing partway up the size slider.
- Panels are rebuilt when the massings, tunnels or skin change, and hidden while tunnels are forming.

---

## 12. Floor plans (`floorplans/`)

- Once the tunnels are finished and the circulation planned, a **deck of floor plans** appears on the right. The chosen floor faces the screen, with the others tilted above and below. It is browsed by wheel, arrow keys, level buttons, clicking or dragging, and can be hidden.
- **One SVG sheet per level** (`draw.js`), at the tunnels' 14 ft storey height. Walls are the massing mesh **cut 1.2 m above each floor**. Tunnels are every tube's run through that storey at its true width, so a sloped tube may seem to cross a hallway that it passes above or below. Hallways, stairs, lifts, doors and entrances come from the circulation plan.
- Sheets are turned to the tunnels' axes (the north arrow shows by how much) and share one frame.
- **Ink-drawing style:** black on white, several fine line weights, walls as double lines, stippled tunnels, hatched unreachable hallways, and single-line title lettering (`lettering.js`).

---

## 13. Saving a site (`library.js`, `core/storage.js`)

- Saved in this **browser's storage** on this computer: the site, every massing (file, position, size, turn), the finished tunnel network and its settings, and the chosen facade and panel size.
- On reopening, the voxels are rebuilt and the saved network is **loaded and carved** instead of grown. Only the airflow is solved again.
- **Unfinished tunnels are not saved.** The save message says so. Tunnels are grown again if the massings no longer match, after **Clear erosion**, or after a change that affects them.
- Sites saved with a single massing by the older version still open.

---

## 14. Where it can't be trusted (honest limits)

- **Potential flow:** no turbulence, separation or friction. It shows where air accelerates, not true speeds. Tunnel speeds are relative to the open wind.
- **Voxel resolution** (about 0.5 to 4 m): thin throats round up to a voxel. The drawn tunnels use the exact radii.
- **The wall-pressure model** is a simplified analytic estimate, not a CFD result.
- **Wind data** is regional reanalysis at 10 m, not measured on site. One year of data is used.
- **Height-map form:** it cannot represent overhangs.
- **Cooling** is a proxy (distance-faded air speed), not a thermal comfort or energy simulation.
- **Facades** are not part of any analysis. Joins can be uneven on rounded forms and at some corners of stepped ones.
- **Skin edges** can look ragged or wavy on walls turned at an angle to the grid, and on some stepped roofs.
- **Floor plans** are concept diagrams, not construction drawings. They show no rooms, windows or occupied spaces, and have no export.
