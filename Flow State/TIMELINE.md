# Flow State: timeline of changes

One line per change, oldest first. Add each new change at the bottom, with its date.

Earlier entries (before 2026-11-20) were written up afterwards from what was asked for in each working session, so they say what was requested and are not checked against the code. Dates are local time. Changes within a day are in order.

## 25 Oct 2026: first version (flowerosion.html)

| Date | Change |
|---|---|
| 2026-10-25 | Started the site as a page following the "Flow State" brief (interior space and building form developed together from site connections), kept in flowerosion.html. |
| 2026-10-25 | Added people that walk along drawn paths and cars that drive along drawn roads. |
| 2026-10-25 | Made people and cars wear tunnels into the imported mass as they pass through it. |
| 2026-10-25 | Added a camera that can go below the horizon, to see the mass from underneath (a right-click orbit was tried and reverted). |
| 2026-10-25 | Tried making the erosion pattern follow the geometry of the imported mass, then removed it in favour of plain uniform erosion along the paths. |
| 2026-10-25 | Added deleting the imported .3dm mass, and made the site open with only the site shown and no layers or erosion switched on. |
| 2026-10-25 | Turned each side-panel heading (Model, Exterior erosion, Interior erosion, Draw, Layers) into a collapsible section with its own colour-coded box. |
| 2026-10-25 | Shrank the corner cubes of the scale box to small points and added a "manipulate" gumball for moving and rotating the model. |
| 2026-10-25 | Changed erosion to happen only where people and cars touch the mass, as thin hair-like slices that widen 1% with each pass. |
| 2026-10-25 | Let pedestrians roam the flat plane inside the mass, entering and leaving only along existing paths, and never leaving where they entered. |
| 2026-10-25 | Made rarely used channels heal over, and capped the slice height at twice the height of the person or car. |

## 26 Oct 2026: wind and sun

| Date | Change |
|---|---|
| 2026-10-26 | Made the wind react to the placed mass and to the surrounding buildings, splitting and gliding round them. |
| 2026-10-26 | Added wind erosion that slowly rounds the mass's edges, windward first, without cutting into it. |
| 2026-10-26 | Showed the wind erosion in the HTML page and removed the peach panels that did not erode. |
| 2026-10-26 | Added a sun simulation that runs through the days of the year at x3, x5, x10 and x15. |
| 2026-10-26 | Added sun growth, where the mass swells towards the sun in proportion to how long each part is lit. |
| 2026-10-26 | Made only one kind of erosion work at a time, all on the same single form, so sun, wind and pedestrians no longer make two forms. |
| 2026-10-26 | Smoothed the pixelated edges of the growth and erosion and treated the mass as a solid with no interior openings. |

## 27 to 29 Oct 2026: deployment

| Date | Change |
|---|---|
| 2026-10-27 | Worked through deploying the site to an AWS server (instance, SSH key, GitHub clone, web folder) and fixed the 403 by moving the Flow State code into the web root. |
| 2026-10-29 | Looked at restoring the cropped view box to its original scale and crop. |

## 10 to 13 Nov 2026: wind tunnels (new, reduced version)

| Date | Change |
|---|---|
| 2026-11-10 | Set the goal of running a wind simulation that erodes tunnels through the mass to speed the air and passively cool the interior, at real-world scale. |
| 2026-11-10 | Cut the site back to generating the site with its wind and sun data, removing drawing of roads and paths and the earlier erosion, to simplify the code. |
| 2026-11-10 | Fixed the site's trouble loading the .3dm mass. |
| 2026-11-10 | Added a solver that chooses where tunnels go for the most cooling in the warmest times of year, and made the tunnel openings appear in the walls. |
| 2026-11-11 | Split the mass into 14 ft storeys and limited tunnels to spanning at most 2 storeys, smaller and spread out to cool both floors evenly. |
| 2026-11-11 | Stopped tunnels opening through the roof and skipped masses that cannot take them. |
| 2026-11-11 | Made the tunnels smooth and rounded, built on a coarser, faster setting first and refined afterwards, and fixed openings that kept changing. |
| 2026-11-13 | Kept the tunnels inside the floor and ceiling zone of each storey (0.9 m) so they do not interfere with interior circulation. |
| 2026-11-13 | Made the mass look like a smooth block of stone worn by tunnels, with the tunnels forming visibly as they erode. |
| 2026-11-13 | Fixed jagged pieces sticking out of the mass, added an X-ray mode (mass faint, tunnels solid), and softened the tunnel ends into the skin. |
| 2026-11-13 | Stopped tunnels from cutting out the corners of the building by moving or shrinking them. |

## 16 Nov 2026: cooling, interior spaces and the vein network

| Date | Change |
|---|---|
| 2026-11-16 | Wrote a summary of what the code does for presenting the software, and put it into slides. |
| 2026-11-16 | Added a "Cooling data" layer in X-ray mode that shades each floor by how well the tunnels cool it. |
| 2026-11-16 | Put the cooling numbers into a collapsible table by floor. |
| 2026-11-16 | Let tunnels grow wider and spread over the floor when the volume rises, keeping 3 ft between them. |
| 2026-11-16 | Removed the rule that kept tunnels in the floor and ceiling zone, so they can form anywhere except roofs and corners. |
| 2026-11-16 | Added Interior erosion: cold and warm occupied spaces (spheres) that can be placed, moved, scaled and overlapped, with the tunnels growing round them. |
| 2026-11-16 | Made the tunnels bend round the spheres like tree roots and join neighbouring tunnels, with none ending in a dead end, and drew them in front of the spheres. |
| 2026-11-16 | Made the tunnels an organic vein network, with branching, thickness and joining driven only by airflow. |
| 2026-11-16 | Tuned the network for more cooling: capped trunk thickness, balanced by floor area, seeded from the top floor, favoured larger through-tunnels with small branches, and raised the volume limit to 40%. |
| 2026-11-16 | Added an optimising loop with faster evaluation and a buoyancy (stack effect) term. |
| 2026-11-16 | Reworked the tunnels so they change size, shape and direction for the best cooling, and made them reach a good form quicker, fewer and thicker. |
| 2026-11-16 | Changed the cooling colour scale to 0 to 50% so the data reads better than all red and yellow. |
| 2026-11-16 | Made the whole form change as the tunnels form: corners slowly round and faces sink in towards openings, softly receding in some places and not in others. |
| 2026-11-16 | Smoothed the erosion and tunnel-making animation so it plays out gradually instead of choppily. |
| 2026-11-16 | Added wind particles that flow in and out of the tunnels, made much denser and steered through the tunnels. |
| 2026-11-16 | Wrote a summary of the main computational strategies (signed distance fields, cooling scores and so on) and replaced the old one. |

## 20 Nov 2026: circulation and the skin

| Date | Change |
|---|---|
| 2026-11-20 | Started a local server (port 8000) so the site opens in Chrome. |
| 2026-11-20 | Fixed wind tunnels that left short segments running along the mass's walls. |
| 2026-11-20 | Added the human circulation system: hallways planned in the gaps between the finished tunnels, with stairs and lifts, starting at a ground-floor entrance. |
| 2026-11-20 | Made the planner find hallways on dense tunnel networks (route through clear space, several roots, detached roots), after it first produced none or only one. |
| 2026-11-20 | Added separate X-ray checkboxes to show the tunnels, the circulation, or both. |
| 2026-11-20 | Added a second "Main cores" mode: 2 stair cores and 1 lift core, each one continuous vertical line, with hallways branching from them and the tunnels bent slightly round the cores. |
| 2026-11-20 | Added "Fill every space that has room" so hallways grow everywhere there is room, with a few extra stairs to join the parts. |
| 2026-11-20 | Added toggles to show accessible (amber) and cut-off (grey-blue) hallways separately. |
| 2026-11-20 | Fixed Main cores covering only half the structure (hallway growth reach, entrance and root selection). |
| 2026-11-20 | Added an optional "Extra stair cores" setting for reaching cut-off hallways (removed later the same day, see below). |
| 2026-11-20 | Added a "Save a snapshot of the tunnels (.json)" button so a plan can be reproduced and checked elsewhere. |
| 2026-11-20 | Investigated tunnels failing on rotated masses and made partial corner-detection fixes in tunnels.js; the full fix is postponed. |
| 2026-11-20 | Redesigned the skin so the rigid end of the "Soften the skin" slider is a flat smooth facade with sharp corners and geometric round, sharp-edged, slanted reveals; the soft end is unchanged. |
| 2026-11-20 | Made the skin reveals larger and deeper. |
| 2026-11-20 | Tried circular windows where circulation meets the skin, then removed them because they were not what was wanted. |
| 2026-11-20 | Fixed the hallway grid so it extends past the mass box, which stops hallways poking through the facade. |
| 2026-11-20 | Added clean rectangular cuts in the skin that follow the outlines of hallways that reach it, with flat walls and no lip. |
| 2026-11-20 | Added a "Wall setback" slider (0 to 1.5 m) so hallways can run right up to the facade and cut windows. |
| 2026-11-20 | Removed the Walk-to-a-hallway, Loops-per-floor, Extra-stair-cores, Wind-layer, Interior-erosion, Erosion-speed and Airflow-slice controls, keeping their defaults. |
| 2026-11-20 | Started this timeline file and filled it in from the earlier sessions. |
| 2026-11-20 | Removed the airflow slice (the blue and red test sheet) completely: its drawing code, its solver call and its saved setting. |
| 2026-11-20 | Removed the Tunnel volume and Warm-air rise sliders, fixing them at 40% and 10 K. |
