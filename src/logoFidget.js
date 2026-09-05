import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import "./logoFidget.css";

const MODEL_URL = "/assets/nebulavm-fidget.glb";
const VIEW_HEIGHT = 8.5;
const LOGO_RADIUS = 0.82;

export async function initLogoFidget(anchor) {
  const canvas = document.createElement("canvas");
  canvas.className = "logo-fidget-layer";
  canvas.hidden = true;
  const grab = document.createElement("button");
  grab.type = "button";
  grab.className = "logo-fidget-grab";
  grab.hidden = true;
  grab.title = "Drag and release to throw the NebulaVM logo";
  grab.setAttribute("aria-label", "Interactive 3D NebulaVM logo. Drag and release to throw it, use arrow keys to move it, press Space to bounce it, or press Escape to return it to the bottom.");
  document.body.append(canvas, grab);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
  } catch {
    canvas.remove();
    grab.remove();
    return;
  }
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-4, 4, VIEW_HEIGHT / 2, -VIEW_HEIGHT / 2, 0.1, 20);
  camera.position.z = 5;
  scene.add(new THREE.HemisphereLight(0xe8fbff, 0x18213a, 2.5));
  const keyLight = new THREE.DirectionalLight(0xffffff, 3.4);
  keyLight.position.set(-3, 5, 6);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0x4ae7ff, 2.4);
  rimLight.position.set(4, 1, 3);
  scene.add(rimLight);

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  let logo;
  try {
    logo = (await loader.loadAsync(MODEL_URL)).scene;
  } catch {
    renderer.dispose();
    canvas.remove();
    grab.remove();
    return;
  }
  const bounds = new THREE.Box3().setFromObject(logo);
  const size = bounds.getSize(new THREE.Vector3());
  logo.position.sub(bounds.getCenter(new THREE.Vector3()));
  logo.scale.setScalar((LOGO_RADIUS * 2) / Math.max(size.x, size.y));
  const logoRoot = new THREE.Group();
  logoRoot.add(logo);
  scene.add(logoRoot);

  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -13.5, 0) });
  const physicsMaterial = new CANNON.Material({ friction: 0.2, restitution: 0.76 });
  world.defaultContactMaterial = new CANNON.ContactMaterial(physicsMaterial, physicsMaterial, { friction: 0.2, restitution: 0.76 });
  const body = new CANNON.Body({ mass: 1, material: physicsMaterial, linearDamping: 0.035, angularDamping: 0.06 });
  const coinRotation = new CANNON.Quaternion();
  coinRotation.setFromEuler(Math.PI / 2, 0, 0);
  body.addShape(new CANNON.Cylinder(LOGO_RADIUS, LOGO_RADIUS, 0.13, 24), new CANNON.Vec3(), coinRotation);
  body.angularVelocity.set(0.7, 1.1, -1.8);
  world.addBody(body);

  let halfWidth = 4;
  let walls = [];
  let firstLayout = true;
  const addWall = (halfExtents, position) => {
    const wall = new CANNON.Body({ mass: 0, material: physicsMaterial, shape: new CANNON.Box(new CANNON.Vec3(...halfExtents)) });
    wall.position.set(...position);
    world.addBody(wall);
    walls.push(wall);
  };
  const rebuildWalls = () => {
    walls.forEach((wall) => world.removeBody(wall));
    walls = [];
    const halfHeight = VIEW_HEIGHT / 2;
    addWall([halfWidth + 0.3, 0.08, 1], [0, -halfHeight - 0.08, 0]);
    addWall([halfWidth + 0.3, 0.08, 1], [0, halfHeight + 0.08, 0]);
    addWall([0.08, halfHeight + 0.2, 1], [-halfWidth - 0.08, 0, 0]);
    addWall([0.08, halfHeight + 0.2, 1], [halfWidth + 0.08, 0, 0]);
    addWall([halfWidth + 0.3, halfHeight + 0.2, 0.06], [0, 0, -0.45]);
    addWall([halfWidth + 0.3, halfHeight + 0.2, 0.06], [0, 0, 0.45]);
  };
  const resize = () => {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.visualViewport?.height || window.innerHeight);
    renderer.setSize(width, height, false);
    halfWidth = (VIEW_HEIGHT * width / height) / 2;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.updateProjectionMatrix();
    rebuildWalls();
    if (firstLayout) {
      body.position.set(0, -VIEW_HEIGHT / 2 + LOGO_RADIUS + 0.1, 0);
      firstLayout = false;
    } else {
      body.position.x = Math.max(-halfWidth + LOGO_RADIUS, Math.min(halfWidth - LOGO_RADIUS, body.position.x));
      body.position.y = Math.max(-VIEW_HEIGHT / 2 + LOGO_RADIUS, Math.min(VIEW_HEIGHT / 2 - LOGO_RADIUS, body.position.y));
    }
  };
  window.addEventListener("resize", resize, { passive: true });
  window.visualViewport?.addEventListener("resize", resize, { passive: true });
  resize();

  let anchorVisible = true;
  let activated = false;
  let dragging = false;
  let pointerY = 0;
  let samples = [];
  const shouldShow = () => (anchorVisible || activated) && !document.fullscreenElement && !document.body.classList.contains("screen-app-fullscreen");
  const updateVisibility = () => {
    const show = shouldShow();
    canvas.hidden = !show;
    grab.hidden = !show;
  };
  new IntersectionObserver(([entry]) => {
    anchorVisible = entry.isIntersecting;
    updateVisibility();
  }, { threshold: 0 }).observe(anchor);
  document.addEventListener("fullscreenchange", updateVisibility);

  const pointerWorld = (event) => {
    const height = Math.max(1, window.visualViewport?.height || window.innerHeight);
    return new THREE.Vector3(
      ((event.clientX / Math.max(1, window.innerWidth)) * 2 - 1) * halfWidth,
      (1 - (event.clientY / height) * 2) * (VIEW_HEIGHT / 2),
      0,
    );
  };
  grab.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    activated = true;
    dragging = true;
    pointerY = event.clientY;
    grab.setPointerCapture(event.pointerId);
    grab.classList.add("is-dragging");
    body.type = CANNON.Body.KINEMATIC;
    body.velocity.setZero();
    body.angularVelocity.setZero();
    const point = pointerWorld(event);
    body.position.set(point.x, point.y, 0);
    samples = [{ point, time: performance.now() }];
    updateVisibility();
  });
  grab.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    event.preventDefault();
    pointerY = event.clientY;
    const point = pointerWorld(event);
    body.position.set(point.x, point.y, 0);
    const now = performance.now();
    samples.push({ point, time: now });
    samples = samples.filter((sample) => now - sample.time <= 120);
  });
  const release = (event) => {
    if (!dragging) return;
    const point = pointerWorld(event);
    const now = performance.now();
    const sample = samples[0] || { point, time: now - 16 };
    const elapsed = Math.max(16, now - sample.time) / 1000;
    const velocity = point.clone().sub(sample.point).multiplyScalar(1 / elapsed).clampLength(0, 15);
    body.type = CANNON.Body.DYNAMIC;
    body.updateMassProperties();
    body.position.set(point.x, point.y, 0);
    body.velocity.set(velocity.x, velocity.y, 0);
    body.angularVelocity.set(velocity.y * 0.4, -velocity.x * 0.4, -velocity.x * 0.85 || 1.2);
    body.wakeUp();
    dragging = false;
    samples = [];
    grab.classList.remove("is-dragging");
  };
  grab.addEventListener("pointerup", release);
  grab.addEventListener("pointercancel", release);
  grab.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      activated = false;
      body.position.set(0, -VIEW_HEIGHT / 2 + LOGO_RADIUS + 0.1, 0);
      body.velocity.setZero();
      updateVisibility();
      return;
    }
    const impulses = { ArrowLeft: [-3, 0, 0], ArrowRight: [3, 0, 0], ArrowUp: [0, 3.5, 0], ArrowDown: [0, -2.5, 0], " ": [0, 6, 0] };
    const impulse = impulses[event.key];
    if (!impulse) return;
    event.preventDefault();
    activated = true;
    body.applyImpulse(new CANNON.Vec3(...impulse));
    body.angularVelocity.z += impulse[0] * -0.5 || 1.1;
    updateVisibility();
  });

  const projected = new THREE.Vector3();
  const updateGrabPosition = () => {
    projected.copy(logoRoot.position).project(camera);
    const rect = grab.getBoundingClientRect();
    const x = (projected.x * 0.5 + 0.5) * window.innerWidth - rect.width / 2;
    const height = window.visualViewport?.height || window.innerHeight;
    const y = (-projected.y * 0.5 + 0.5) * height - rect.height / 2;
    grab.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };
  canvas.addEventListener("nebulavm-probe-frame", () => renderer.render(scene, camera));
  let previous = performance.now();
  const render = (now) => {
    requestAnimationFrame(render);
    if (!shouldShow() || document.hidden) { previous = now; return; }
    if (dragging) {
      const edge = 72;
      if (pointerY < edge) window.scrollBy(0, -Math.ceil((edge - pointerY) / 5));
      else if (pointerY > window.innerHeight - edge) window.scrollBy(0, Math.ceil((pointerY - window.innerHeight + edge) / 5));
    }
    const delta = Math.min((now - previous) / 1000, 1 / 20);
    previous = now;
    world.step(1 / 60, delta, 3);
    logoRoot.position.copy(body.position);
    logoRoot.quaternion.copy(body.quaternion);
    updateGrabPosition();
    renderer.render(scene, camera);
  };
  updateVisibility();
  requestAnimationFrame(render);
}
