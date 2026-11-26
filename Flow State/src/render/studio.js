// VIEW (render): the full-screen render view. It has a renderer, scene and cameras of its own, so the working view is left
// as it is. While the camera moves, a frame is drawn with one sun and a soft fill from the sky. Once it is still, the
// picture is refined: many frames are averaged, each with the sun shifted a little (soft shadows), light from another part
// of the sky (shading where surfaces are close together) and the camera shifted by less than a pixel (smooth edges).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const SAMPLES = 96; // frames in a refined picture
const SHOW_AFTER = 24; // the refined picture replaces the moving one once it has this many
const TURN_SECONDS = 36; // one orbit
const SUN = { intensity: 3.5, colour: 0xffe6c2 };
const FOV = 28;

const quadVertex = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Adds one frame into the running average.
const blendFragment = /* glsl */ `
uniform sampler2D uFrame, uSum;
uniform float uWeight;
varying vec2 vUv;
void main() { gl_FragColor = mix(texture2D(uSum, vUv), texture2D(uFrame, vUv), uWeight); }`;

// The finished picture: filmic tone curve, a gentle warm grade and a slight darkening to the corners.
const finishFragment = /* glsl */ `
uniform sampler2D uPicture;
uniform float uExposure;
varying vec2 vUv;
vec3 film(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec3 c = film(texture2D(uPicture, vUv).rgb * uExposure);
  float grey = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(grey), c, 1.06) * vec3(1.015, 1.0, 0.975);
  c *= 1.0 - 0.22 * pow(length(vUv - 0.5) * 1.25, 3.0);
  vec3 srgb = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  gl_FragColor = vec4(srgb + dither / 255.0, 1.0);
}`;

const HAZE = new THREE.Color(0xc9d3d8);

// A sky for reflections: bright haze at the horizon, blue above, warm ground below, and a few bright panels, which give
// polished metal something to catch.
function skyEnvironment(renderer, sunDirection) {
  const scene = new THREE.Scene();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(100, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { uSun: { value: sunDirection } },
      vertexShader: "varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: /* glsl */ `
        uniform vec3 uSun;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec3 up = mix(vec3(0.82, 0.86, 0.9), vec3(0.22, 0.4, 0.72), pow(clamp(d.y, 0.0, 1.0), 0.55));
          vec3 down = mix(vec3(0.5, 0.47, 0.4), vec3(0.14, 0.13, 0.1), clamp(-d.y * 3.0, 0.0, 1.0));
          vec3 c = d.y > 0.0 ? up : down;
          c += vec3(6.0, 4.9, 3.4) * pow(max(dot(d, uSun), 0.0), 180.0);
          gl_FragColor = vec4(c, 1.0);
        }`,
    })
  );
  scene.add(sky);
  for (const [x, y, z, w, h, power] of [[-60, 28, 20, 14, 46, 2.2], [30, 18, -66, 40, 9, 1.6], [10, 70, 10, 30, 30, 1.2]]) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(power, power, power * 1.03), side: THREE.DoubleSide }));
    panel.position.set(x, y, z);
    panel.lookAt(0, 0, 0);
    scene.add(panel);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(scene, 0.02).texture;
  pmrem.dispose();
  scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  return texture;
}

const halton = (i, base) => { let f = 1, r = 0; while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); } return r; };

// `focus`: { centre (Vector3), size (m, across the project) }. `onStatus(text)` reports the refining.
export function createStudio(canvas, focus, onStatus) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = HAZE;
  const reach = Math.max(110, focus.size * 2.4); // m: shadows are worked out this far from the project
  scene.fog = new THREE.Fog(HAZE, reach * 3.2, reach * 11);

  const sunDirection = new THREE.Vector3(-0.62, 0.6, 0.5).normalize();
  scene.environment = skyEnvironment(renderer, sunDirection);

  const light = (colour, mapSize, bias) => {
    const l = new THREE.DirectionalLight(colour, 1);
    l.castShadow = true;
    l.shadow.mapSize.set(mapSize, mapSize);
    Object.assign(l.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: reach * 6 });
    l.shadow.bias = -0.00012;
    l.shadow.normalBias = bias;
    l.target.position.copy(focus.centre);
    l.shadow.autoUpdate = false; // (nothing in the scene moves: a shadow is worked out again only when its light or what is shown changes)
    scene.add(l, l.target);
    return l;
  };
  const sun = light(SUN.colour, 4096, (2 * reach) / 4096);
  const skyLight = light(0xcfe0f5, 2048, (2.4 * reach) / 2048);
  const fill = new THREE.HemisphereLight(0xcfe0f5, 0x8a7c66, 1);
  scene.add(fill);
  const aim = (l, direction) => l.position.copy(focus.centre).addScaledVector(direction, reach * 2.5);

  // cameras: a long-lens perspective, and a true axonometric
  const perspective = new THREE.PerspectiveCamera(FOV, 1, 1, reach * 40);
  const axo = new THREE.OrthographicCamera(-1, 1, 1, -1, -reach * 20, reach * 40);
  const viewHeight = Math.max(26, focus.size * 1.45);// m: what fits in the frame's height to begin with
  const distance = viewHeight / (2 * Math.tan((FOV * Math.PI) / 360));
  const start = new THREE.Vector3(0.72, 0.52, 0.72).normalize();
  perspective.position.copy(focus.centre).addScaledVector(start, distance);
  axo.position.copy(focus.centre).addScaledVector(new THREE.Vector3(1, Math.SQRT1_2, 1).normalize(), reach * 4);
  let camera = perspective, controls = null, orbiting = true;

  let still = 0; // frames accumulated
  let dirty = true;
  let waiting = null; // what to do once the picture is refined (see whenRefined)
  const restart = () => { still = 0; dirty = true; };

  // Has the camera moved to be seen since the picture was begun? This is judged here, not from the controls' "change"
  // event: with the axonometric camera that is raised on every frame (rounding in its far-off position is enough), and the
  // picture would never be refined. The pose is compared with the one the picture was begun from, so that a slow drift
  // still counts once it adds up.
  const begun = { turn: new THREE.Quaternion(), target: new THREE.Vector3(), distance: 0, zoom: 1 };
  const cameraMoved = () => {
    const distance = camera.position.distanceTo(controls.target);
    const moved =
      camera.quaternion.angleTo(begun.turn) > 2e-4 ||
      controls.target.distanceTo(begun.target) > viewHeight * 2e-4 ||
      Math.abs(distance - begun.distance) > distance * 2e-4 ||
      Math.abs(camera.zoom - begun.zoom) > camera.zoom * 2e-4;
    if (moved) {
      begun.turn.copy(camera.quaternion);
      begun.target.copy(controls.target);
      Object.assign(begun, { distance, zoom: camera.zoom });
    }
    return moved;
  };

  const useCamera = (next) => {
    controls?.dispose();
    camera = next;
    controls = new OrbitControls(camera, canvas);
    controls.target.copy(focus.centre);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.autoRotate = orbiting;
    controls.autoRotateSpeed = 60 / TURN_SECONDS;
    if (camera.isPerspectiveCamera) { controls.minDistance = 8; controls.maxDistance = reach * 7; }
    controls.enabled = !waiting;
    controls.update();
    restart();
  };

  // targets: the frame just drawn, and two that take turns holding the average
  const options = { type: THREE.HalfFloatType, colorSpace: THREE.NoColorSpace };
  const frame = new THREE.WebGLRenderTarget(1, 1, { ...options, samples: 4 });
  let sum = new THREE.WebGLRenderTarget(1, 1, { ...options, depthBuffer: false });
  let spare = sum.clone();
  const screen = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  const pass = new THREE.Scene();
  pass.add(quad);
  const blend = new THREE.ShaderMaterial({ vertexShader: quadVertex, fragmentShader: blendFragment, uniforms: { uFrame: { value: null }, uSum: { value: null }, uWeight: { value: 1 } }, depthTest: false, depthWrite: false });
  const finish = new THREE.ShaderMaterial({ vertexShader: quadVertex, fragmentShader: finishFragment, uniforms: { uPicture: { value: null }, uExposure: { value: 0.96 } }, depthTest: false, depthWrite: false });
  const draw = (material, target) => {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(pass, screen);
  };

  const size = new THREE.Vector2();
  function resize() {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    renderer.getDrawingBufferSize(size);
    for (const t of [frame, sum, spare]) t.setSize(size.x, size.y);
    perspective.aspect = w / h;
    perspective.updateProjectionMatrix();
    Object.assign(axo, { left: (-viewHeight * w) / h / 2, right: (viewHeight * w) / h / 2, top: viewHeight / 2, bottom: -viewHeight / 2 });
    axo.updateProjectionMatrix();
    restart();
  }

  const direction = new THREE.Vector3();
  let shadowStale = true; // is the sun's shadow out of date for the moving picture?
  function movingLights() {
    if (shadowStale) {
      aim(sun, sunDirection);
      sun.shadow.needsUpdate = true;
      skyLight.shadow.needsUpdate = !skyLight.shadow.map; // (it gives no light here, but its map must exist)
      shadowStale = false;
    }
    sun.intensity = SUN.intensity;
    skyLight.intensity = 0;
    fill.intensity = 0.55;
  }
  function sampleLights(i) {
    // the sun as a small disc
    direction.set(halton(i, 2) - 0.5, halton(i, 3) - 0.5, halton(i, 5) - 0.5).multiplyScalar(0.055).add(sunDirection).normalize();
    aim(sun, direction);
    sun.intensity = SUN.intensity;
    // one part of the sky, more often from high up (spread evenly over the samples)
    const around = halton(i, 7) * Math.PI * 2, high = Math.sqrt(0.06 + 0.94 * halton(i, 2));
    direction.set(Math.cos(around) * Math.sqrt(1 - high * high), high, Math.sin(around) * Math.sqrt(1 - high * high));
    aim(skyLight, direction);
    skyLight.intensity = 1.25;
    fill.intensity = 0.1;
    sun.shadow.needsUpdate = skyLight.shadow.needsUpdate = true;
    shadowStale = true;
  }

  function renderScene(target) {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
  }
  function showMoving() {
    movingLights();
    camera.clearViewOffset();
    renderScene(frame);
    finish.uniforms.uPicture.value = frame.texture;
    draw(finish, null);
  }
  function accumulate() {
    const i = still + 1;
    sampleLights(i);
    camera.setViewOffset(size.x, size.y, halton(i, 2) - 0.5, halton(i, 3) - 0.5, size.x, size.y);
    renderScene(frame);
    camera.clearViewOffset();
    blend.uniforms.uFrame.value = frame.texture;
    blend.uniforms.uSum.value = sum.texture;
    blend.uniforms.uWeight.value = 1 / i;
    draw(blend, spare);
    [sum, spare] = [spare, sum];
    still = i;
    if (still >= SHOW_AFTER) {
      finish.uniforms.uPicture.value = sum.texture;
      draw(finish, null);
    }
  }

  let last = performance.now();
  function tick(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    controls.update(dt);
    if (cameraMoved()) restart();
    if (orbiting) { showMoving(); onStatus(""); return; }
    if (dirty) { showMoving(); dirty = false; return; }
    if (still < SAMPLES) {
      accumulate();
      onStatus(still < SAMPLES ? `Refining the picture… ${Math.round((100 * still) / SAMPLES)}%` : "Picture refined");
    }
    // (asked for before or after the picture was finished, it is answered as soon as there is one)
    if (still >= SAMPLES && waiting) {
      const done = waiting;
      waiting = null;
      controls.enabled = true;
      done();
    }
  }

  useCamera(perspective);
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  renderer.setAnimationLoop(tick);

  return {
    scene,
    // Call when what is shown has changed.
    refresh() {
      shadowStale = true;
      restart();
    },
    get orbiting() { return orbiting; },
    setOrbit(on) {
      orbiting = on;
      controls.autoRotate = on;
      restart();
    },
    setProjection(kind) {
      const next = kind === "axo" ? axo : perspective;
      if (next === camera) return;
      // (the new camera looks the same way as the old one)
      direction.subVectors(camera.position, controls.target).normalize();
      next.position.copy(controls.target).addScaledVector(direction, next === axo ? reach * 4 : distance);
      useCamera(next);
    },
    get refined() { return !orbiting && still >= SAMPLES; },
    // Calls `done` once, when the picture is refined (at the next frame if it already is). Until then the camera can't be
    // dragged, which would begin the picture again. `null` calls off what was asked for.
    whenRefined(done) {
      waiting = done;
      controls.enabled = !done;
    },
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      const textures = new Set();
      scene.traverse((o) => {
        o.geometry?.dispose();
        for (const m of [o.material].flat().filter(Boolean)) {
          if (m.map) textures.add(m.map);
          if (m.roughnessMap) textures.add(m.roughnessMap);
          m.dispose();
        }
      });
      textures.forEach((t) => t.dispose());
      scene.environment?.dispose();
      for (const t of [frame, sum, spare]) t.dispose();
      sun.dispose();
      skyLight.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
