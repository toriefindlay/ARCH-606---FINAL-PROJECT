import { mountExterior } from "./exterior/index.js";
import { mountInterior } from "./interior/index.js";
import { mountCirculation } from "./circulation/index.js";
import { mountCost } from "./cost/index.js";

mountExterior();
mountInterior();
mountCirculation(); // (last: it reads the finished tunnels, and nothing reads it)
mountCost(); // (reads the finished tunnels and the site's temperatures, changes nothing)
