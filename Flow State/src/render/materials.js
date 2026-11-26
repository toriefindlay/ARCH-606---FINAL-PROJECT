// VIEW (render): the materials of the render view. Every texture is drawn here on a canvas, so nothing is downloaded.
// Textures are laid out in metres: see worldUV, which gives any mesh its texture coordinates.
import * as THREE from "three";

// A repeatable random number generator, so that a render looks the same every time.
export function randomiser(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// Speckles `count` soft dots of random lightness over a canvas.
export function speckle(ctx, w, h, rand, count, size, strength) {
  for (let i = 0; i < count; i++) {
    const light = rand() < 0.5 ? 0 : 255;
    ctx.fillStyle = `rgba(${light},${light},${light},${rand() * strength})`;
    const r = size * (0.3 + rand());
    ctx.fillRect(rand() * w, rand() * h, r, r);
  }
}

// A texture that covers `metres` x `metresHigh` and repeats.
export function canvasTexture(w, h, metres, metresHigh, draw, colour = true) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext("2d"), w, h, randomiser(w * 31 + h + Math.round(metres * 100)));
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / metres, 1 / metresHigh);
  t.anisotropy = 8;
  if (colour) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Cast concrete: soft clouding, grain, the joints of 2.4 x 1.2 m formwork panels and their tie holes.
const concrete = () =>
  canvasTexture(1024, 1024, 4.8, 4.8, (ctx, w, h, rand) => {
    ctx.fillStyle = "#b9b5ad";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {
      const x = rand() * w, y = rand() * h, r = 30 + rand() * 130, v = rand() < 0.5 ? 90 : 230;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${v},${v - 3},${v - 8},0.09)`);
      g.addColorStop(1, `rgba(${v},${v - 3},${v - 8},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    speckle(ctx, w, h, rand, 26000, 2.2, 0.16);
    ctx.fillStyle = "rgba(60,56,50,0.35)";
    for (let k = 0; k < 4; k++) ctx.fillRect(0, (k * h) / 4, w, 2);
    for (let k = 0; k < 2; k++) ctx.fillRect((k * w) / 2, 0, 2, h);
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(((i + 0.5) * w) / 4, ((j + 0.5) * h) / 4, 5, 0, 7);
        ctx.fill();
      }
    }
  });

// Sawn timber, the grain running along u.
const wood = () =>
  canvasTexture(512, 256, 1.6, 0.4, (ctx, w, h, rand) => {
    ctx.fillStyle = "#c99a63";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 150; i++) {
      const y = rand() * h, dark = rand() < 0.65;
      ctx.strokeStyle = dark ? `rgba(122,74,34,${0.1 + rand() * 0.35})` : `rgba(240,205,150,${0.1 + rand() * 0.3})`;
      ctx.lineWidth = 0.6 + rand() * 2.6;
      ctx.beginPath();
      const phase = rand() * 6, wave = rand() * 4;
      for (let x = 0; x <= w; x += 16) ctx.lineTo(x, y + Math.sin((x / w) * Math.PI * 2 + phase) * wave);
      ctx.stroke();
    }
    speckle(ctx, w, h, rand, 2500, 2, 0.1);
  });

// Brushed sheet metal: fine streaks round the duct, read as roughness.
const brushed = () =>
  canvasTexture(256, 256, 1, 1, (ctx, w, h, rand) => {
    ctx.fillStyle = "#9a9a9a";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      const v = rand() < 0.5 ? 60 : 220;
      ctx.fillStyle = `rgba(${v},${v},${v},${rand() * 0.18})`;
      ctx.fillRect(0, rand() * h, w, 1);
    }
  }, false);

// How each facade's panels are finished (their colours are the panels' own).
const FACADE_FINISH = {
  triangle: { metalness: 0.55, roughness: 0.42 }, // anodised aluminium shades
  cubic: { metalness: 0.0, roughness: 0.82 }, // white precast blocks
  organic: { metalness: 0.0, roughness: 0.7 }, // moulded glass-fibre concrete
  fins: { metalness: 0.15, roughness: 0.55 }, // coated timber-toned blades
  hex: { metalness: 0.35, roughness: 0.36 }, // painted aluminium hoods
};

export function createMaterials() {
  const standard = (options) => new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...options });
  const grain = brushed();
  const woodMap = wood();
  const made = {
    concrete: standard({ map: concrete(), roughness: 0.9, metalness: 0 }),
    metal: standard({ color: 0xd9dde1, metalness: 1, roughness: 0.34, roughnessMap: grain, envMapIntensity: 1.25 }),
    seam: standard({ color: 0xaeb4ba, metalness: 1, roughness: 0.28, envMapIntensity: 1.2 }),
    wood: standard({ map: woodMap, roughness: 0.72 }),
    deck: standard({ map: woodMap, color: 0xd9c3a0, roughness: 0.8 }),
    steel: standard({ color: 0x4a5158, metalness: 0.85, roughness: 0.45 }),
    frame: standard({ color: 0x8c3b32, metalness: 0.55, roughness: 0.5 }), // the structure's steel, in red oxide primer
    door: standard({ map: woodMap, color: 0x8a5a38, roughness: 0.5 }),
    ghost: new THREE.LineBasicMaterial({ color: 0x4d4a45, transparent: true, opacity: 0.3 }),
  };
  made.facade = (style) => standard({ vertexColors: true, flatShading: true, ...(FACADE_FINISH[style] ?? FACADE_FINISH.cubic) });
  return made;
}

// A double-sided material turns a triangle's normals round when it is seen from behind, going by the order of its corners.
// A triangle whose corners run the other way from its normals would so be lit from the wrong side: its corners are
// put in the order that agrees with them. (The geometry has its own corners for every triangle.)
function faceTheirNormals(g) {
  const p = g.attributes.position, n = g.attributes.normal;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), face = new THREE.Vector3(), side = new THREE.Vector3(), sum = new THREE.Vector3(), v = new THREE.Vector3();
  const swap = (attribute, i, j) => {
    for (let k = 0; k < 3; k++) {
      const t = attribute.array[i * 3 + k];
      attribute.array[i * 3 + k] = attribute.array[j * 3 + k];
      attribute.array[j * 3 + k] = t;
    }
  };
  for (let i = 0; i + 2 < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    face.subVectors(b, a).cross(side.subVectors(c, a));
    sum.set(0, 0, 0);
    for (let k = 0; k < 3; k++) sum.add(v.fromBufferAttribute(n, i + k));
    if (face.dot(sum) < 0) { swap(p, i + 1, i + 2); swap(n, i + 1, i + 2); }
  }
}

// A copy of a geometry with its own corners for every triangle and texture coordinates in metres, taken from the two world
// axes the triangle faces least (walls: along and up; floors: x and z). `matrix` (optional) takes it into the world first.
export function worldUV(geometry, matrix = null) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  if (matrix) g.applyMatrix4(matrix);
  if (!g.attributes.normal) g.computeVertexNormals();
  const p = g.attributes.position, uv = new Float32Array(p.count * 2);
  faceTheirNormals(g);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), side = new THREE.Vector3();
  for (let i = 0; i + 2 < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    n.subVectors(c, b).cross(side.subVectors(a, b)).normalize();
    const flat = Math.abs(n.y) > 0.7;
    const along = Math.hypot(n.x, n.z) || 1, tx = -n.z / along, tz = n.x / along; // (the way along a wall)
    [a, b, c].forEach((v, k) => {
      uv[(i + k) * 2] = flat ? v.x : v.x * tx + v.z * tz;
      uv[(i + k) * 2 + 1] = flat ? v.z : v.y;
    });
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}
