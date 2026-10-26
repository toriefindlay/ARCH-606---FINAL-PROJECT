# Flow State — interior Boids demo

Open **index.html in this folder** in a modern browser. This standalone demo works offline, with no install or build step. It intentionally leaves the shared site app and exterior module unchanged.

Alternatively, from the repository root run `python3 -m http.server 8000` and visit:
http://localhost:8000/Flow%20State/src/erosion/interior/boids/index.html

## Demonstrate it

1. Watch the example in Cube view, then switch to Plan view to place modifiers easily.
2. Click Wall, Gathering point, Entrance / exit, Attractor, or Repulsor; click the scene to place it at the height slider's value. Entrance and exit are two modes of the fifth-family portal tool (five modifier families total).
3. Select / move picks the centre marker. Drag horizontally; use the height slider to move vertically. Edit its radius, or wall dimensions/direction. Delete removes the selected modifier.
4. Pause, hide trails or density, change flocking/wandering, and compare against an Empty cube. Restart uses the same seed. Changing geometry or population starts a fresh run and clears density and arrivals.
5. Export layout + density downloads JSON with modifier coordinates, settings, seed, simulation time and the 20 × 20 density grid. Export is a record, not an import or exact state checkpoint.

The cube is 20 m on each side; x/z are horizontal and y is height. Walls are axis-aligned boxes and fit within the cube. Other modifiers are spherical influences, illustrated with horizontal rings. Plan view projects all heights. Agents fly freely in 3D: this is a conceptual spatial exploration, not a floor-constrained pedestrian simulation.

Separation, alignment, cohesion and seeded random forces influence motion. Attractors pull locally, repulsors push locally, and gathering points attract then hold arrivals for 2.5 seconds with an 8-second cooldown. Exits pull globally; entering an exit radius respawns an agent at an entrance (or random free space if no entrances exist). The population remains constant. Closed layouts may trap agents: there is no global path planner. Walls use swept collision tests with a 0.18 m agent radius. Agents already inside a newly placed wall are respawned when the run resets.

Trails hold up to 90 samples per agent. Density sums agent-seconds in 1 m² floor cells through every height. Its colour scale is normalized to the current run's peak; compare exported numbers for quantitative comparisons, not colour alone. Simulation uses fixed 1/60-second steps, limits catch-up during slow frames, and pauses when paused or dragging. Real elapsed time can differ from simulation time.

This prototype does not carve the imported mass or produce SDF cuts. It is isolated under the interior-owned folder, ready to inform a later reviewed integration with `provideCuts`. It is not a validated crowd, accessibility or evacuation analysis.

## Source and checks

- `model.js`: pure simulation and collision helpers; browser global and CommonJS exports.
- `app.js`: controls, projection, picking, canvas drawing and JSON export.
- `style.css`, `index.html`: presentation and accessible labelled controls.
- `check.cjs`: run `node check.cjs` from this folder.
- Existing repository checks remain available with `node check.cjs` from the repository root.

No third-party libraries, network calls, persistent storage or generated build files are required. Refreshing the page restores the example. Speed/flocking/wandering changes apply during a run, so use Restart after adjusting them for repeatable comparisons. Simulation work scales quadratically with agent count; the UI caps it at 200.
