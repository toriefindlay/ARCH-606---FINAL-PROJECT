import * as THREE from "three";

// World convention used everywhere: x = east, y = up, z = -north, in metres, site pin at the origin.

// Local equirectangular projection returning (east, north) in metres.
export function makeProjector(lat0, lon0) {
  const mLat = 111320;
  const mLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return (lat, lon) => new THREE.Vector2((lon - lon0) * mLon, (lat - lat0) * mLat);
}
