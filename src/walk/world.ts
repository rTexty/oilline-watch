import {
  BoxGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry, DoubleSide,
  Fog, Group, HemisphereLight, IcosahedronGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  PlaneGeometry, PointLight, RepeatWrapping, Scene, ShaderMaterial, SphereGeometry, Sprite,
  SpriteMaterial, SRGBColorSpace, Texture, TorusGeometry, Vector3, DirectionalLight, type BufferGeometry,
  type Material, type Object3D, type PerspectiveCamera, type Raycaster,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PATH_LIGHTS, WALK_TARGETS, isPressureId, type TargetId } from './model';

export type WalkVisualState = {
  readonly scanner: boolean;
  readonly sleeve: boolean;
  readonly scanned: boolean;
  readonly repaired: boolean;
  readonly valveClosed: boolean;
  readonly equipped: HeldTool;
};

type HeldTool = 'scanner' | 'sleeve' | null;
const PIPE_Y = 1.25;
const PIPE_Z = -3;
const PIPE_RADIUS = 0.83;
const PALETTE = {
  teal: 0x6edadf,
  peach: 0xff965b,
  green: 0xa5f0b9,
  blue: 0x577e91,
  navy: 0x263944,
  steel: 0x74878a,
};

function surface(color: number, roughness = 0.75, metalness = 0) {
  return new MeshStandardMaterial({ color, roughness, metalness });
}

function luminous(color: number, intensity = 0.85) {
  return new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.42 });
}

function addMesh(parent: Object3D, geometry: BufferGeometry, material: Material, x: number, y: number, z: number) {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

function box(parent: Object3D, material: Material, at: readonly [number, number, number], size: readonly [number, number, number]) {
  return addMesh(parent, new BoxGeometry(...size), material, ...at);
}

function cylinder(parent: Object3D, material: Material, at: readonly [number, number, number], radius: number, height: number, segments = 20) {
  return addMesh(parent, new CylinderGeometry(radius, radius, height, segments), material, ...at);
}

function ring(parent: Object3D, material: Material, x: number, radius: number, thickness: number) {
  const mesh = addMesh(parent, new TorusGeometry(radius, thickness, 9, 32), material, x, PIPE_Y, PIPE_Z);
  mesh.rotation.y = Math.PI / 2;
  return mesh;
}

function floor(parent: Object3D, material: Material, width: number, depth: number, x: number, z: number, y: number) {
  const mesh = addMesh(parent, new PlaneGeometry(width, depth), material, x, y, z);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

function canvasTexture(width: number, height: number, paint: (context: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create field texture');
  paint(context);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function randomSequence(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
}

function groundTexture() {
  const random = randomSequence(9241);
  return canvasTexture(256, 256, (context) => {
    context.fillStyle = '#8b8881';
    context.fillRect(0, 0, 256, 256);
    for (let index = 0; index < 3_000; index++) {
      const light = random() > 0.48;
      context.fillStyle = light ? '#a6a49f78' : '#55585156';
      context.fillRect(random() * 256, random() * 256, 1 + random() * 4, 1 + random() * 3);
    }
  });
}

function contactShadowTexture() {
  return canvasTexture(64, 64, (context) => {
    const radial = context.createRadialGradient(32, 32, 4, 32, 32, 31);
    radial.addColorStop(0, '#081720bf');
    radial.addColorStop(0.48, '#0817206b');
    radial.addColorStop(1, '#08172000');
    context.fillStyle = radial;
    context.fillRect(0, 0, 64, 64);
  });
}

function addLandscape(scene: Scene, shadow: Material) {
  const sky = new ShaderMaterial({
    side: DoubleSide,
    depthWrite: false,
    uniforms: {
      zenith: { value: new Color(0x203e58) },
      horizon: { value: new Color(0x8d9fab) },
      glow: { value: new Color(0xfab37b) },
    },
    vertexShader: `
      varying vec3 direction;
      void main() {
        direction = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 zenith;
      uniform vec3 horizon;
      uniform vec3 glow;
      varying vec3 direction;

      void main() {
        vec3 ray = normalize(direction);
        float height = smoothstep(-0.06, 0.72, ray.y);
        vec3 sun = normalize(vec3(0.83, 0.11, -0.46));
        float radial = max(0.0, dot(ray, sun));
        vec3 sky = mix(horizon, zenith, height);
        sky = mix(sky, glow, pow(radial, 10.0) * 0.73);
        sky += glow * smoothstep(0.9985, 0.9995, radial) * 0.6;
        gl_FragColor = vec4(sky, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const skySphere = addMesh(scene, new SphereGeometry(107, 32, 16), sky, 27, 0, 1);
  skySphere.renderOrder = -10;

  const grain = groundTexture();
  grain.wrapS = grain.wrapT = RepeatWrapping;
  grain.repeat.set(34, 22);
  const earth = new MeshStandardMaterial({ color: 0x60655d, roughness: 1, map: grain });
  const ground = floor(scene, earth, 212, 136, 28, 0, -0.035);
  ground.receiveShadow = true;
  const road = surface(0x3b494b);
  const shore = surface(0x657269);
  floor(scene, shore, 88, 11, 29, -0.4, -0.012);
  floor(scene, shore, 86, 0.88, 29, 4.53, 0.006);
  const lane = floor(scene, road, 86, 8.3, 29, 0, 0.001);
  lane.receiveShadow = true;
  floor(scene, shadow, 82, 3.1, 29, -2.6, 0.012);

  const random = randomSequence(657);
  const hillFace = surface(0x4a6573);
  const distantFace = surface(0x4a6173);
  for (let index = 0; index < 22; index++) {
    const x = -22 + index * 5.5 + random() * 3;
    const z = -35 - random() * 26;
    const hill = addMesh(scene, new IcosahedronGeometry(1, 0), index % 2 ? hillFace : distantFace, x, -3, z);
    hill.scale.set(7 + random() * 18, 6 + random() * 13, 7 + random() * 14);
    hill.rotation.y = random() * Math.PI;
  }
  const stone = surface(0x5a6863);
  const rockShape = new IcosahedronGeometry(1, 0);
  for (let index = 0; index < 56; index++) {
    const z = index % 2 === 0 ? 6 + random() * 24 : -9 - random() * 17;
    const rock = addMesh(scene, rockShape, stone, -11 + random() * 88, 0.07, z);
    const size = 0.1 + random() * 0.52;
    rock.scale.set(size * 1.6, size * 0.55, size);
    rock.rotation.y = random() * Math.PI;
  }
  for (let index = 0; index < 12; index++) {
    const ridge = addMesh(scene, rockShape, distantFace, 33 + index * 6.6, -2.3, 37 + random() * 20);
    ridge.scale.set(12 + random() * 12, 3.5 + random() * 3, 8 + random() * 11);
    ridge.rotation.y = random() * Math.PI;
  }
}

function addLighting(scene: Scene) {
  scene.add(new HemisphereLight(0xc4e0ff, 0x6e675e, 2.2));
  const sunset = new DirectionalLight(0xffcf9f, 2.35);
  sunset.position.set(40, 18, -24);
  scene.add(sunset);
  const bounce = new DirectionalLight(0x8bcbe2, 0.92);
  bounce.position.set(-16, 10, 16);
  scene.add(bounce);
}

function addPipe(scene: Scene) {
  const body = surface(PALETTE.blue, 0.37, 0.56);
  const welded = surface(0x426379, 0.4, 0.46);
  const flange = surface(PALETTE.navy, 0.4, 0.46);
  const metal = surface(PALETTE.steel, 0.42, 0.43);
  const brass = surface(0xb87a48, 0.49, 0.25);
  const footing = surface(0x4e5656, 0.84);
  const pipe = cylinder(scene, body, [29, PIPE_Y, PIPE_Z], PIPE_RADIUS, 82, 32);
  pipe.rotation.z = Math.PI / 2;
  const stripe = ring(scene, brass, -11.85, 0.84, 0.045);
  stripe.name = 'inlet';
  const flangePoint = WALK_TARGETS.find(({ id }) => id === 'flange')!;
  for (const x of [-12, 1, flangePoint.x, 17.3, 18.7, 27, 40, 53, 66, 70]) {
    const collar = cylinder(scene, flange, [x, PIPE_Y, PIPE_Z], 1.01, 0.26, 30);
    collar.rotation.z = Math.PI / 2;
    ring(scene, metal, x - 0.14, 0.95, 0.045);
    ring(scene, metal, x + 0.14, 0.95, 0.045);
    const boltGeometry = new CylinderGeometry(0.064, 0.064, 0.34, 6);
    for (let index = 0; index < 8; index++) {
      const angle = (index + 0.5) * Math.PI / 4;
      const bolt = addMesh(scene, boltGeometry, brass, x, PIPE_Y + Math.cos(angle) * 0.89, PIPE_Z + Math.sin(angle) * 0.89);
      bolt.rotation.z = Math.PI / 2;
    }
  }
  for (const x of [-7, 6, 10, 22, 34, 46, 58, 64]) {
    ring(scene, welded, x, 0.837, 0.022);
    box(scene, metal, [x, 0.45, PIPE_Z], [0.35, 0.7, 1.13]);
    box(scene, footing, [x, 0.1, PIPE_Z], [1.42, 0.2, 1.7]);
    box(scene, flange, [x, 0.31, PIPE_Z], [0.55, 0.1, 1.42]);
  }
}

function addTrack(scene: Scene) {
  const paint = new MeshBasicMaterial({ color: 0xb98753 });
  const lanePaint = new MeshBasicMaterial({ color: 0x788987 });
  const grate = surface(PALETTE.steel, 0.72, 0.22);
  for (let x = -12; x < 70; x += 2.6) {
    floor(scene, paint, 1.3, 0.052, x, -1.625, 0.015);
    floor(scene, lanePaint, 1.15, 0.038, x, 4.07, 0.013);
  }
  for (const x of [-8, 8, 26, 51, 67]) {
    for (let stripe = 0; stripe < 8; stripe++) floor(scene, paint, 0.57, 0.105, x, -1.26 + stripe * 0.22, 0.017);
    floor(scene, grate, 0.53, 0.45, x, 3.95, 0.018);
  }
}

function addBuiltEnvironment(scene: Scene) {
  const frame = surface(0x394c53, 0.63, 0.22);
  const brightFrame = surface(0x637577);
  const wall = surface(0x576b70);
  const housing = surface(0x384a51);
  const glass = luminous(0xe6a457, 0.7);
  const cyan = luminous(0x72c6d6, 0.32);
  const groundLead = surface(0x101f25);
  for (const x of [-5, 12, 29, 46, 64]) {
    for (const z of [14.2, -7.6]) {
      if (x === -5 && z > 0) continue;
      cylinder(scene, frame, [x, 2.0, z], 0.062, 4.0, 8);
      box(scene, brightFrame, [x, 0.07, z], [0.35, 0.14, 0.34]);
      box(scene, housing, [x, 4.04, z], [0.57, 0.19, 0.32]);
      box(scene, glass, [x, 3.93, z], [0.47, 0.03, 0.24]);
      if (x === -5 || (x === 12 && z < 0)) {
        const light = new PointLight(0xffb575, 33, 10, 2);
        light.position.set(x, 3.72, z);
        scene.add(light);
      }
    }
  }
  for (const x of [21, 24, 30, 33]) {
    cylinder(scene, brightFrame, [x, 2.1, -12.4], 1.15, 4.12, 24);
    addMesh(scene, new ConeGeometry(1.19, 0.57, 24), frame, x, 4.44, -12.4);
    box(scene, housing, [x, 0.15, -12.4], [2.8, 0.3, 2.8]);
    box(scene, groundLead, [x, 2.20, -11.17], [0.1, 4.04, 0.11]);
    const bar = box(scene, cyan, [x, 2.52, -11.13], [0.75, 0.067, 0.043]);
    bar.name = 'service light';
  }
  for (const x of [6, 14, 53, 61]) {
    box(scene, frame, [x, 1.1, -9.7], [3.1, 2.2, 3.5]);
    box(scene, wall, [x, 1.28, -7.93], [2.97, 1.7, 0.05]);
    box(scene, frame, [x, 2.26, -9.7], [3.52, 0.13, 3.9]);
    box(scene, glass, [x, 1.65, -7.89], [1.55, 0.3, 0.06]);
    for (let index = -1; index <= 1; index++) {
      box(scene, brightFrame, [x + index * 0.57, 1.27, -7.84], [0.036, 1.76, 0.06]);
    }
  }
  for (let x = -8; x <= 67; x += 3.2) {
    cylinder(scene, brightFrame, [x, 0.65, -6.85], 0.029, 1.3, 6);
    if (x <= 64) {
      box(scene, frame, [x + 1.6, 1.13, -6.85], [3.23, 0.028, 0.029]);
      box(scene, frame, [x + 1.6, 0.56, -6.85], [3.23, 0.019, 0.02]);
    }
  }
  for (const { x, z } of PATH_LIGHTS) {
    box(scene, frame, [x, 0.09, z], [0.38, 0.18, 0.38]);
    cylinder(scene, wall, [x, 0.47, z], 0.047, 0.84, 7);
    cylinder(scene, glass, [x, 0.86, z], 0.054, 0.1, 7);
  }
}

function batchStaticMeshes(scene: Scene) {
  const groups = new Map<string, Mesh[]>();
  for (const child of scene.children) {
    if (!(child instanceof Mesh) || Array.isArray(child.material) || child.material.transparent || child.renderOrder !== 0) continue;
    const key = `${child.material.uuid}:${child.geometry.index !== null}:${child.receiveShadow}`;
    const meshes = groups.get(key) ?? [];
    meshes.push(child);
    groups.set(key, meshes);
  }
  const retired = new Set<BufferGeometry>();
  for (const meshes of groups.values()) {
    const example = meshes[0];
    if (!example || Array.isArray(example.material) || meshes.length < 2) continue;
    const transformed = meshes.map((mesh) => {
      mesh.updateMatrix();
      return mesh.geometry.clone().applyMatrix4(mesh.matrix);
    });
    const geometry = mergeGeometries(transformed);
    transformed.forEach((item) => item.dispose());
    if (!geometry) continue;
    const batch = addMesh(scene, geometry, example.material, 0, 0, 0);
    batch.receiveShadow = example.receiveShadow;
    for (const mesh of meshes) {
      retired.add(mesh.geometry);
      scene.remove(mesh);
    }
  }
  for (const child of scene.children) {
    if (child instanceof Mesh) retired.delete(child.geometry);
  }
  for (const geometry of retired) geometry.dispose();
}

const LABEL_WIDTH = 2.25;
const LABEL_HEIGHT = 0.668;

function label(text: string, accent: string) {
  const map = canvasTexture(256, 76, (context) => {
    context.fillStyle = '#10222de8';
    context.strokeStyle = accent;
    context.lineWidth = 3;
    context.beginPath();
    context.roundRect(4, 4, 248, 68, 13);
    context.fill();
    context.stroke();
    context.fillStyle = accent;
    context.font = '650 28px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 128, 39, 226);
  });
  const sprite = new Sprite(new SpriteMaterial({ map, transparent: true, depthWrite: false }));
  sprite.scale.set(LABEL_WIDTH, LABEL_HEIGHT, 1);
  return sprite;
}

function addLabel(scene: Object3D, text: string, accent: string, x: number, y: number, z: number) {
  const sprite = label(text, accent);
  sprite.position.set(x, y, z);
  scene.add(sprite);
  return sprite;
}

function scannerProp() {
  const tool = new Group();
  const plastic = surface(0xf1aa58, 0.56);
  const rubber = surface(0x172630, 0.8);
  box(tool, rubber, [0, -0.047, 0.003], [0.102, 0.15, 0.104]);
  box(tool, plastic, [0, 0.05, 0], [0.159, 0.205, 0.091]);
  box(tool, rubber, [0, 0.04, 0.049], [0.13, 0.16, 0.017]);
  box(tool, luminous(PALETTE.teal, 0.67), [0, 0.059, 0.059], [0.096, 0.089, 0.006]);
  box(tool, luminous(0xc4ffda, 0.9), [-0.018, 0.059, 0.064], [0.036, 0.009, 0.002]);
  for (const x of [-0.032, 0, 0.032]) box(tool, plastic, [x, -0.005, 0.061], [0.016, 0.016, 0.007]);
  box(tool, rubber, [0, 0.151, 0], [0.11, 0.025, 0.072]);
  return tool;
}

function sleeveProp() {
  const tool = new Group();
  const metal = surface(0x9b9d82, 0.42, 0.36);
  const seam = surface(0x826042, 0.54, 0.24);
  const band = new TorusGeometry(0.106, 0.018, 8, 24);
  for (const z of [-0.026, 0.026]) addMesh(tool, band, metal, 0, 0, z);
  box(tool, seam, [0.106, 0, 0], [0.037, 0.052, 0.108]);
  box(tool, seam, [-0.106, 0, 0], [0.037, 0.052, 0.108]);
  return tool;
}

function makeViewHands(scene: Scene) {
  const rig = new Group();
  scene.add(rig);
  const arm = new Group();
  arm.scale.setScalar(0.82);
  rig.add(arm);
  const uniform = surface(0x344c61, 0.73);
  const stripe = surface(0xeed9a3, 0.76);
  const gloves = surface(0x232b33);
  const forearm = cylinder(arm, uniform, [0.052, -0.10, 0.106], 0.053, 0.35, 10);
  forearm.rotation.set(-0.78, 0, -0.45);
  const cuff = cylinder(arm, stripe, [0.018, -0.048, 0.051], 0.052, 0.047, 10);
  cuff.rotation.copy(forearm.rotation);
  box(arm, gloves, [0, -0.009, 0.012], [0.077, 0.089, 0.08]);
  box(arm, gloves, [-0.035, 0.013, -0.008], [0.032, 0.053, 0.04]);
  const scanner = scannerProp();
  scanner.position.set(-0.021, 0.054, -0.036);
  scanner.rotation.set(-0.16, 0.17, -0.16);
  arm.add(scanner);
  const sleeve = sleeveProp();
  sleeve.position.set(-0.066, 0.058, -0.044);
  sleeve.rotation.set(-0.26, 0.36, 0.19);
  arm.add(sleeve);
  rig.visible = false;
  return { rig, arm, scanner, sleeve };
}

function makeAvatar(scene: Scene, shadow: Material) {
  const avatar = new Group();
  const contact = floor(avatar, shadow, 1.58, 1.35, 0, 0, 0.026);
  contact.name = 'operator shadow';
  scene.add(avatar);
  const uniform = surface(0x344c61, 0.73);
  const cloth = surface(0x253746);
  const vest = surface(0xcb5b2a, 0.72);
  const stripe = surface(0xeed9a3, 0.76);
  const hardHat = surface(0xfab255, 0.36);
  const boots = surface(0x252b31);
  const skin = surface(0xc88b68);
  const pack = surface(0x77857d);
  const body = addMesh(avatar, new CylinderGeometry(0.29, 0.22, 0.58, 8), uniform, 0, 1.24, 0);
  body.scale.z = 0.71;
  box(avatar, vest, [0, 1.25, 0], [0.48, 0.47, 0.33]);
  box(avatar, stripe, [0, 1.18, 0], [0.486, 0.057, 0.335]);
  for (const side of [-1, 1]) {
    box(avatar, stripe, [side * 0.134, 1.36, 0], [0.057, 0.27, 0.337]);
  }
  box(avatar, cloth, [0, 0.99, 0], [0.36, 0.095, 0.305]);
  box(avatar, pack, [0, 1.36, -0.2], [0.286, 0.275, 0.1]);
  box(avatar, luminous(PALETTE.teal, 0.48), [0, 1.39, -0.255], [0.12, 0.04, 0.016]);
  addMesh(avatar, new SphereGeometry(0.153, 12, 10), skin, 0, 1.66, 0);
  const helmet = addMesh(avatar, new SphereGeometry(0.192, 16, 10, 0, 2 * Math.PI, 0, Math.PI * 0.51), hardHat, 0, 1.75, 0.004);
  helmet.scale.z = 1.06;
  cylinder(avatar, hardHat, [0, 1.745, 0.031], 0.213, 0.029, 18);
  const arms: Group[] = [];
  const legs: Group[] = [];
  for (const sign of [-1, 1]) {
    const arm = new Group();
    arm.position.set(sign * 0.286, 1.43, 0);
    cylinder(arm, uniform, [0, -0.21, 0], 0.078, 0.42, 8);
    cylinder(arm, boots, [0, -0.45, 0], 0.067, 0.119, 8);
    avatar.add(arm);
    arms.push(arm);
    const leg = new Group();
    leg.position.set(sign * 0.115, 0.98, 0);
    cylinder(leg, uniform, [0, -0.445, 0], 0.095, 0.77, 8);
    box(leg, boots, [0, -0.894, 0.052], [0.182, 0.15, 0.308]);
    avatar.add(leg);
    legs.push(leg);
  }
  const toolArm = arms[1]!;
  const carriedScanner = scannerProp();
  carriedScanner.position.set(0.051, -0.493, 0.049);
  carriedScanner.rotation.set(-0.36, 0.42, 0.36);
  const carriedSleeve = sleeveProp();
  carriedSleeve.position.set(0.071, -0.452, 0.058);
  carriedSleeve.rotation.set(-0.32, 0.50, 0.49);
  toolArm.add(carriedScanner, carriedSleeve);

  function step(time: number, stride: number, tool: HeldTool, reach: number) {
    const gait = Math.sin(time * (stride > 0.72 ? 12 : 8)) * stride;
    for (let index = 0; index < legs.length; index++) {
      const sign = index === 0 ? -1 : 1;
      legs[index]!.rotation.x = sign * gait * 0.53;
      arms[index]!.rotation.x = -sign * gait * 0.46;
    }
    toolArm.rotation.z = tool || reach > 0 ? 0.26 : 0;
    if (tool || reach > 0) toolArm.rotation.x = -0.72 - reach * 0.54 - gait * 0.12;
  }

  return { avatar, carriedScanner, carriedSleeve, step };
}

function addPressureStation(scene: Scene, x: number, z: number, text: string) {
  const base = surface(0x415c62);
  const body = surface(0x1e363f);
  const edge = surface(0x8d9a8e);
  const screen = luminous(0x69d9d0, 0.59);
  const signal = luminous(0xd9b560, 0.58);
  const stand = new Group();
  scene.add(stand);
  box(stand, edge, [x, 0.065, z - 0.1], [0.89, 0.13, 0.69]);
  box(stand, base, [x, 0.59, z - 0.1], [0.22, 1.05, 0.19]);
  const monitor = new Group();
  monitor.position.set(x, 1.15, z);
  monitor.rotation.y = -0.44;
  box(monitor, body, [0, 0, 0], [0.7, 0.52, 0.2]);
  box(monitor, screen, [0, 0.042, 0.104], [0.49, 0.25, 0.017]);
  for (let key = 0; key < 3; key++) box(monitor, signal, [-0.13 + key * 0.13, -0.163, 0.11], [0.054, 0.038, 0.015]);
  stand.add(monitor);
  cylinder(stand, base, [x, 2.11, PIPE_Z], 0.05, 0.23, 10);
  box(stand, edge, [x, 2.33, PIPE_Z], [0.28, 0.24, 0.42]);
  box(stand, screen, [x, 2.33, PIPE_Z + 0.22], [0.17, 0.11, 0.022]);
  addLabel(stand, text, '#8fede1', x, 2.17, z);
  return stand;
}

function addTool(scene: Scene, x: number, z: number, labelText: string, kind: 'scanner' | 'sleeve') {
  const caseDark = surface(0x273c43);
  const tray = surface(0xb78350);
  const crate = new Group();
  const item = new Group();
  scene.add(item, crate);
  box(crate, caseDark, [x, 0.22, z], [0.96, 0.44, 0.8]);
  box(crate, tray, [x, 0.464, z], [1.03, 0.08, 0.86]);
  for (const corner of [-0.36, 0.36]) box(crate, tray, [x + corner, 0.237, z + 0.409], [0.103, 0.32, 0.028]);
  if (kind === 'scanner') {
    const plastic = surface(0xf2ac59);
    box(item, plastic, [x, 0.63, z], [0.42, 0.16, 0.31]);
    box(item, luminous(PALETTE.teal, 1.1), [x + 0.045, 0.721, z], [0.24, 0.015, 0.22]);
    box(item, caseDark, [x - 0.21, 0.643, z], [0.18, 0.096, 0.11]);
  } else {
    const shell = addMesh(item, new TorusGeometry(0.195, 0.06, 8, 20), surface(0xcda46f, 0.49, 0.24), x, 0.7, z);
    shell.rotation.x = 0.32;
  }
  addLabel(item, labelText, '#ffd08f', x, 1.37, z);
  return { item, crate };
}

function addValve(scene: Scene, x: number, z: number) {
  const body = surface(0x754837, 0.47, 0.38);
  const casting = surface(0x9e563b, 0.49, 0.35);
  const hub = surface(0xce9b64, 0.52, 0.25);
  const assembly = new Group();
  scene.add(assembly);
  cylinder(assembly, body, [x, 1.71, PIPE_Z], 0.494, 0.72);
  cylinder(assembly, casting, [x, 2.12, PIPE_Z], 0.52, 0.11);
  cylinder(assembly, hub, [x, 2.48, PIPE_Z], 0.105, 0.72);
  const wheel = new Group();
  wheel.position.set(x, 2.84, PIPE_Z);
  const wheelRing = addMesh(wheel, new TorusGeometry(0.53, 0.052, 9, 28), casting, 0, 0, 0);
  wheelRing.rotation.x = Math.PI / 2;
  for (let spoke = 0; spoke < 3; spoke++) {
    const bar = box(wheel, casting, [0, 0, 0], [1.04, 0.053, 0.047]);
    bar.rotation.y = spoke * Math.PI / 3;
  }
  box(wheel, hub, [0, 0.012, 0], [0.205, 0.13, 0.205]);
  assembly.add(wheel);
  addLabel(assembly, 'Задвижка', '#ffd08f', x, 3.6, z - 0.32);
  return { assembly, wheel };
}

function addMarkedPatch(parent: Object3D, x: number, width: number, radius: number, color: number) {
  const band = new CylinderGeometry(radius, radius, width, 24, 1, true, -Math.PI * 0.55, Math.PI * 1.1);
  const patch = addMesh(parent, band, luminous(color, 0.20), x, PIPE_Y, PIPE_Z);
  patch.rotation.z = Math.PI / 2;
  return patch;
}

function addLeak(scene: Scene, x: number, z: number) {
  const accent = luminous(PALETTE.peach, 0.78);
  const marking = new Group();
  const alert = new Group();
  const repaired = new Group();
  const fixture = surface(0x816c53, 0.67, 0.31);
  box(scene, fixture, [x, 0.2, PIPE_Z], [0.55, 0.4, 1.6]);
  addMarkedPatch(marking, x, 0.76, 0.852, 0x91714c);
  ring(marking, luminous(0xffc077, 0.34), x - 0.4, 0.849, 0.018);
  ring(marking, luminous(0xffc077, 0.34), x + 0.4, 0.849, 0.018);
  addLabel(marking, 'Зона проверки', '#ffcb92', x, 2.75, z - 1.26);
  const collar = cylinder(repaired, surface(0xa0a387, 0.39, 0.48), [x, PIPE_Y, PIPE_Z], 0.9, 0.79, 32);
  collar.rotation.z = Math.PI / 2;
  ring(repaired, luminous(PALETTE.green, 0.65), x - 0.37, 0.907, 0.025);
  ring(repaired, luminous(PALETTE.green, 0.65), x + 0.37, 0.907, 0.025);
  for (const y of [1.17, 1.38]) box(repaired, fixture, [x, y, -2.07], [0.66, 0.065, 0.13]);
  addLabel(alert, 'Утечка', '#ffb987', x, 2.75, z - 1.26);
  const particles: Mesh[] = [];
  const spark = new SphereGeometry(0.055, 6, 6);
  for (let index = 0; index < 13; index++) {
    const particle = addMesh(alert, spark, accent, x, 1.43, -2.16);
    particle.userData.ignorePicking = true;
    particles.push(particle);
  }
  addMarkedPatch(alert, x, 0.76, 0.852, 0xb95b43);
  ring(alert, accent, x, 0.863, 0.035);
  addLabel(repaired, 'Муфта установлена', '#a5f0b9', x, 2.75, z - 1.26);
  scene.add(marking, alert, repaired);

  function animate(time: number) {
    if (!alert.visible) return;
    for (const [index, particle] of particles.entries()) {
      const progress = (time * 1.32 + index / particles.length) % 1;
      particle.position.set(x + 0.27 * progress * Math.sin(index), 1.42 + 1.13 * progress - 0.84 * progress ** 2, -2.16 + 1.3 * progress);
      particle.scale.setScalar(1 - progress * 0.65);
    }
  }

  return { marking, alert, repaired, animate };
}

function target(id: TargetId) {
  return WALK_TARGETS.find((point) => point.id === id)!;
}

function visible(object: Object3D) {
  for (let current: Object3D | null = object; current; current = current.parent) {
    if (!current.visible) return false;
  }
  return true;
}

function makePicker(scene: Scene, registrations: ReadonlyMap<TargetId, readonly Object3D[]>) {
  const selectable = new Map<Object3D, TargetId>();
  const toolAvailability = new Map<Object3D, Object3D>();
  const blockers: Object3D[] = [];
  for (const [id, roots] of registrations) {
    for (const root of roots) root.traverse((object) => {
      if (object.userData.ignorePicking || !(object instanceof Mesh || object instanceof Sprite)) return;
      selectable.set(object, id);
      if (id === 'scanner' || id === 'sleeve') toolAvailability.set(object, roots[0]!);
    });
  }
  scene.traverse((object) => {
    if (!(object instanceof Mesh) || object.userData.ignorePicking || object.renderOrder < 0
      || Array.isArray(object.material) || object.material.transparent) return;
    blockers.push(object);
  });

  return function pick(ray: Raycaster): TargetId | null {
    const candidates = [...selectable.keys()].filter((object) => {
      const tool = toolAvailability.get(object);
      return visible(object) && (!tool || tool.visible);
    });
    const hit = ray.intersectObjects(candidates, false).find(({ object, uv }) => {
      if (!(object instanceof Sprite)) return true;
      if (!uv) return false;
      const x = uv.x * 256;
      const y = uv.y * 76;
      return Math.hypot(Math.max(17 - x, x - 239, 0), Math.max(17 - y, y - 59, 0)) <= 13;
    });
    if (!hit) return null;

    const originalFar = ray.far;
    ray.far = hit.distance - 0.007;
    try {
      const blocker = ray.intersectObjects(blockers.filter(visible), false)[0];
      return blocker ? null : selectable.get(hit.object) ?? null;
    } finally {
      ray.far = originalFar;
    }
  };
}

export function createWorld() {
  const scene = new Scene();
  const selections = new Map<TargetId, readonly Object3D[]>();
  scene.background = new Color(0x839ba9);
  scene.fog = new Fog(0x879dab, 34, 109);
  addLighting(scene);
  const shadow = new MeshBasicMaterial({
    map: contactShadowTexture(), transparent: true, depthWrite: false, opacity: 0.77,
  });
  addLandscape(scene, shadow);
  addTrack(scene);
  addBuiltEnvironment(scene);
  addPipe(scene);
  batchStaticMeshes(scene);
  for (const { id, x, z } of WALK_TARGETS) {
    if (isPressureId(id)) selections.set(id, [addPressureStation(scene, x, z, id)]);
  }
  const scannerPoint = target('scanner');
  const scanner = addTool(scene, scannerPoint.x, scannerPoint.z, scannerPoint.label, 'scanner');
  const sleevePoint = target('sleeve');
  const sleeve = addTool(scene, sleevePoint.x, sleevePoint.z, 'Муфта', 'sleeve');
  selections.set('scanner', [scanner.item, scanner.crate]);
  selections.set('sleeve', [sleeve.item, sleeve.crate]);
  const valvePoint = target('valve');
  const valve = addValve(scene, valvePoint.x, valvePoint.z);
  selections.set('valve', [valve.assembly]);
  const leakPoint = target('leak');
  const leak = addLeak(scene, leakPoint.x, leakPoint.z);
  selections.set('leak', [leak.marking, leak.alert, leak.repaired]);
  for (const id of ['flange', 'shell'] as const) {
    const point = target(id);
    const assembly = new Group();
    scene.add(assembly);
    if (id === 'flange') ring(assembly, luminous(0x82c6d2, 0.18), point.x, 1.019, 0.025);
    else addMarkedPatch(assembly, point.x, 0.7, 0.85, 0x587c86);
    addLabel(assembly, point.label, '#a0d9e3', point.x, 2.56, point.z - 0.54);
    selections.set(id, [assembly]);
  }
  const pick = makePicker(scene, selections);
  const { avatar, carriedScanner, carriedSleeve, step } = makeAvatar(scene, shadow);
  const hands = makeViewHands(scene);
  const labels: Sprite[] = [];
  scene.traverse((object) => { if (object instanceof Sprite) labels.push(object); });
  const labelPosition = new Vector3();
  let equipped: HeldTool = null;
  let using: { readonly tool: HeldTool; readonly startedAt: number } | null = null;
  let viewCamera: PerspectiveCamera | null = null;

  function showTool(tool: HeldTool) {
    carriedScanner.visible = hands.scanner.visible = tool === 'scanner';
    carriedSleeve.visible = hands.sleeve.visible = tool === 'sleeve';
  }

  function animate(time: number, stride: number, leakTime: number) {
    const progress = using === null ? 1 : Math.min((performance.now() - using.startedAt) / 390, 1);
    if (progress >= 1) using = null;
    const reach = Math.sin(progress * Math.PI);
    const tool = using === null ? equipped : using.tool;
    showTool(tool);
    step(time, stride, tool, reach);
    if (viewCamera && hands.rig.visible) {
      const depth = 0.59 + reach * 0.18;
      const halfHeight = Math.tan(viewCamera.fov * Math.PI / 360) * depth;
      const gait = Math.sin(time * 9) * stride;
      hands.arm.position.set(halfHeight * viewCamera.aspect * (0.69 - reach * 0.25),
        -halfHeight * (0.68 - reach * 0.28) + gait * 0.008, -depth);
      hands.arm.rotation.set(reach * -0.34, reach * 0.12, gait * 0.028);
    }
    leak.animate(leakTime);
  }

  function setView(camera: PerspectiveCamera, firstPerson: boolean) {
    avatar.visible = !firstPerson;
    hands.rig.visible = firstPerson;
    viewCamera = camera;
    camera.updateMatrixWorld();
    const limit = Math.tan(camera.fov * Math.PI / 360) * (camera.aspect < 0.85 ? 0.35 : 0.52);
    for (const sprite of labels) {
      const depth = -sprite.getWorldPosition(labelPosition).applyMatrix4(camera.matrixWorldInverse).z;
      const scale = Math.min(1, Math.max(0.05, depth * limit / LABEL_WIDTH));
      sprite.scale.set(LABEL_WIDTH * scale, LABEL_HEIGHT * scale, 1);
    }
    if (!firstPerson) return;
    camera.getWorldPosition(hands.rig.position);
    camera.getWorldQuaternion(hands.rig.quaternion);
  }

  function playUse(tool: HeldTool) {
    using = { tool: tool ?? equipped, startedAt: performance.now() };
  }

  function sync(state: WalkVisualState) {
    if (equipped !== state.equipped) using = null;
    equipped = state.equipped;
    scanner.item.visible = !state.scanner;
    sleeve.item.visible = !state.sleeve && !state.repaired;
    showTool(using === null ? equipped : using.tool);
    valve.wheel.rotation.y = state.valveClosed ? Math.PI / 4 : 0;
    leak.marking.visible = !state.scanned && !state.repaired;
    leak.alert.visible = state.scanned && !state.repaired;
    leak.repaired.visible = state.repaired;
  }

  function dispose() {
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    const maps = new Set<Texture>();
    scene.traverse((object) => {
      if (object instanceof Mesh) {
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      } else if (object instanceof Sprite) {
        materials.add(object.material);
      }
    });
    for (const material of materials) {
      if ('map' in material && material.map instanceof Texture) maps.add(material.map);
      material.dispose();
    }
    for (const geometry of geometries) geometry.dispose();
    for (const map of maps) map.dispose();
    scene.clear();
  }

  sync({ scanner: false, sleeve: false, scanned: false, repaired: false, valveClosed: false, equipped: null });
  return { scene, avatar, animate, sync, pick, setView, playUse, isUsingTool: () => using !== null, dispose };
}
