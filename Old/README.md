# Flow study — a beginner-friendly circulation demonstration

## Run
Open `index.html` in a modern browser. No installation, account, internet connection, or build step is required. Keep all four source files together.

If your browser restricts local files, run `python3 -m http.server 8000` from this folder and open http://localhost:8000. Stop the server with Ctrl+C.

## Try a before/after experiment
1. Select only **Library** to make the difference easy to see.
2. Choose Fast and click **Run 60 pedestrians**. Wait for 60 / 60 arrivals.
3. Click **Save “before” snapshot**.
4. Enable **Edit door locations**. Select Library and move its slider from 27 to 35, or click the highlighted wall at its right end.
5. Run again. The average path gets longer. Compare both heatmaps and route lengths.
6. Discard the snapshot to unlock destination selection. Restore original layout whenever desired.

The saved snapshot stays intact while you edit. Editing clears the current run. Only one completed batch is accumulated at a time; starting another run resets its heatmap. Both heatmaps use the same colour scale. There is no persistent storage: reloading resets the demonstration.

## Full editable source
- `index.html`: page structure, controls, and drawing surfaces.
- `style.css`: colours, typography, and responsive layout.
- `pathfinding.js`: the five-room grid, entrances, door positions, destinations, and A* algorithm. Start here to study the computational logic.
- `app.js`: destination selection, trip generation, animation, heat accumulation, drawing, and before/after snapshots.
- `check.cjs`: optional model checks; run `node check.cjs` if Node.js is installed.

## How the script works
The plan is a 37 × 25 boolean grid. True cells are walkable; false cells are walls. Five rectangular rooms connect to a three-cell-wide corridor through single-cell doorways. Every trip starts at the left entrance and ends at a fixed point in one of the selected rooms.

A* searches four neighbouring cells at a time. Each step costs 1. The priority is the distance travelled so far plus the Manhattan distance remaining. A parent map reconstructs the shortest route. A simple sorted array keeps this readable; a larger model would benefit from a priority queue.

Sixty trips are assigned round-robin across selected rooms, with no randomness. When the count cannot divide evenly, earlier selected rooms receive one extra trip. Saving a baseline locks the destinations, so both runs use identical demand. Pedestrians follow precomputed routes; each entry into a grid cell adds one heatmap visit. Animation speed changes playback only, not routes or final totals.

Mean route length is the mean number of grid steps across all 60 planned trips (shown while the batch runs). Peak cell visits is the highest cumulative count so far, including the entrance; every completed trip batch will give the shared entrance 60 visits. Use the spatial heatmap and mean route length to inspect layout differences, not the peak alone.

## Scope and limitations
This is an architectural scripting prototype, not a validated crowd, accessibility, evacuation, or safety analysis. It models one-way trips, equal walking speeds, and equal cell costs. People can overlap; there is no collision avoidance, queueing, dwell time, or congestion-dependent routing. Ties between equally short paths are resolved deterministically, so a narrow band of heat can reflect algorithm choice. Grid steps have no real-world scale.

## Useful next steps for a seven-week project
Add a cell-to-metre scale, user-defined room demand, multiple entrances, furniture obstacles, destination dwell times, and exportable comparisons. After the routing model is understood, add collision avoidance as a separate layer and compare its outputs with observed movement. Keep small test layouts so each new rule can be checked independently.
