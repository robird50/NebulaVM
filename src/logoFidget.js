import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import "./logoFidget.css";

const MODEL_URL = "/assets/nebulavm-fidget.glb";
const VIEW_HEIGHT = 4.6;

export async function initLogoFidget(zone) {
  const canvas = zone.querySelector("#logoFidgetCanvas");
  const status = zone.querySelector("#logoFidgetStatus");
  if (!canvas || !status) return;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
  } catch {
    status.textContent = "The 3D logo is unavailable on this device.";
    return;
  }

  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-2.3, 2.3, 2.3, -2.3, 0.1, 20);
  camera.position.set(0, 0, 5);
  scene.add(new THREE.HemisphereLight(0xdffaff, 0x172033, 2.3));
  const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
  keyLight.position.set(-3, 5, 6);
  keyLight.castShadow = true;
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0x63e6ff, 2.2);
  rimLight.position.set(4, 1, 3);
  scene.add(rimLight);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 5),
    new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.34 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2.12;
  floor.receiveShadow = true;
  scene.add(floor);

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  let logo;
  try {
    const gltf = await loader.loadAsync(MODEL_URL);
    logo = gltf.scene;
  } catch {
    renderer.dispose();
    status.textContent = "The 3D logo could not be loaded.";
    return;
  }

  const bounds = new THREE.Box3().setFromObject(logo);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  logo.position.sub(center);
  logo.scale.setScalar(1.55 / Math.max(size.x, size.y));
  logo.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;
  });
  const logoRoot = new THREE.Group();
  logoRoot.add(logo);
  scene.add(logoRoot);

  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.allowSleep = true;
  const material = new CANNON.Material({ friction: 0.24, restitution: 0.72 });
  world.defaultContactMaterial = new CANNON.ContactMaterial(material, material, {
    friction: 0.24,
    restitution: 0.72,
  });
  const body = new CANNON.Body({ mass: 1, material, linearDamping: 0.08, angularDamping: 0.12 });
  const coinRotation = new CANNON.Quaternion();
  coinRotation.setFromEuler(Math.PI / 2, 0, 0);
  body.addShape(new CANNON.Cylinder(0.78, 0.78, 0.12, 24), new CANNON.Vec3(), coinRotation);
  body.position.set(0.35, 1.25, 0);
  body.angularVelocity.set(0.5, 0.8, -1.4);
  world.addBody(body);

  let walls = [];
  let halfWidth = 2.3;
  const rebuildWalls = () => {
    walls.forEach((wall) => world.removeBody(wall));
    walls = [];
    const addWall = (halfExtents, position) => {
      const wall = new CANNON.Body({ mass: 0, material, shape: new CANNON.Box(new CANNON.Vec3(...halfExtents)) });
      wall.position.set(...position);
      world.addBody(wall);
      walls.push(wall);
    };
    addWall([halfWidth + 0.4, 0.1, 1], [0, -2.3, 0]);
    addWall([halfWidth + 0.4, 0.1, 1], [0, 2.3, 0]);
    addWall([0.1, 2.4, 1], [-halfWidth - 0.1, 0, 0]);
    addWall([0.1, 2.4, 1], [halfWidth + 0.1, 0, 0]);
    addWall([halfWidth + 0.4, 2.4, 0.08], [0, 0, -0.48]);
    addWall([halfWidth + 0.4, 2.4, 0.08], [0, 0, 0.48]);
  };

  const resize = () => {
    const width = Math.max(1, zone.clientWidth);
    const height = Math.max(1, zone.clientHeight);
    renderer.setSize(width, height, false);
    halfWidth = (VIEW_HEIGHT * width / height) / 2;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = VIEW_HEIGHT / 2;
    camera.bottom = -VIEW_HEIGHT / 2;
    camera.updateProjectionMatrix();
    rebuildWalls();
  };
  new ResizeObserver(resize).observe(zone);
  resize();

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const dragPoint = new THREE.Vector3();
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  let dragging = false;
  let lastDrag = null;

  const pointFromEvent = (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    raycaster.ray.intersectPlane(dragPlane, dragPoint);
    return dragPoint;
  };
  canvas.addEventListener("pointerdown", (event) => {
    pointFromEvent(event);
    if (!raycaster.intersectObject(logoRoot, true).length) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    dragging = true;
    lastDrag = { point: dragPoint.clone(), time: performance.now() };
    body.type = CANNON.Body.KINEMATIC;
    body.velocity.setZero();
    body.angularVelocity.setZero();
    canvas.classList.add("is-dragging");
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    event.preventDefault();
    pointFromEvent(event);
    const now = performance.now();
    body.position.set(dragPoint.x, dragPoint.y, 0);
    if (!lastDrag || now - lastDrag.time > 45) lastDrag = { point: dragPoint.clone(), time: now };
  });
  const release = (event) => {
    if (!dragging) return;
    pointFromEvent(event);
    const now = performance.now();
    const elapsed = Math.max(16, now - lastDrag.time) / 1000;
    const velocity = dragPoint.clone().sub(lastDrag.point).multiplyScalar(1 / elapsed).clampLength(0, 13);
    body.type = CANNON.Body.DYNAMIC;
    body.updateMassProperties();
    body.velocity.set(velocity.x, velocity.y, 0);
    body.angularVelocity.set(velocity.y * 0.35, -velocity.x * 0.35, -velocity.x * 0.7);
    dragging = false;
    canvas.classList.remove("is-dragging");
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("keydown", (event) => {
    const impulses = { ArrowLeft: [-2.5, 0, 0], ArrowRight: [2.5, 0, 0], ArrowUp: [0, 3, 0], ArrowDown: [0, -2, 0], " ": [0, 5, 0] };
    const impulse = impulses[event.key];
    if (!impulse) return;
    event.preventDefault();
    body.wakeUp();
    body.applyImpulse(new CANNON.Vec3(...impulse));
    body.angularVelocity.z += impulse[0] * -0.45 || 0.9;
  });

  status.hidden = true;
  zone.classList.add("is-ready");
  canvas.addEventListener("nebulavm-probe-frame", () => renderer.render(scene, camera));
  let visible = true;
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }, { threshold: 0.01 }).observe(zone);
  let previous = performance.now();
  const render = (now) => {
    requestAnimationFrame(render);
    if (!visible || document.hidden) { previous = now; return; }
    const delta = Math.min((now - previous) / 1000, 1 / 20);
    previous = now;
    world.step(1 / 60, delta, 3);
    logoRoot.position.copy(body.position);
    logoRoot.quaternion.copy(body.quaternion);
    renderer.render(scene, camera);
  };
  requestAnimationFrame(render);
}
