type Vec = readonly [number, number, number];
export type Camera = { readonly yaw: number; readonly pitch: number; readonly zoom: number };
type Appearance = { readonly sensors: boolean; readonly positionM: number | null; readonly revealed: boolean };
type Mesh = { readonly type: 'triangles' | 'lines'; readonly vertices: number[] };

export const PIPE_LENGTH_M = 1_000;
export const LEAK_GRID_STEP_M = 5;
export const DEFAULT_CAMERA: Camera = { yaw: 0.24, pitch: 0.26, zoom: 1 };
export const PRESSURE_STATIONS = [
  { label: 'P1', locationM: 100, color: '#72def9', tint: [0.25, 0.76, 0.93] },
  { label: 'P2', locationM: 500, color: '#c3b0ff', tint: [0.62, 0.48, 0.93] },
  { label: 'P3', locationM: 900, color: '#76efd2', tint: [0.28, 0.84, 0.72] },
] as const;
const HALF = 6.4;
const RADIUS = 0.52;
const INNER_RADIUS = 0.41;
const FOV = Math.PI / 4;
const CENTRE: Vec = [0, -0.12, 0];
const SENSOR_TOP = 1.071;
const REVEAL_TOP = [1.23, 0.66] as const;
const NEAR = 0.08;
const FAR = 250;
const positionX = (positionM: number) => (2 * positionM / PIPE_LENGTH_M - 1) * HALF;

const vertexCode = `
attribute vec3 position;
attribute vec3 normal;
attribute vec3 tint;
uniform mat4 viewProjection;
uniform vec3 offset;
varying mediump vec3 world;
varying mediump vec3 direction;
varying mediump vec3 material;
void main() {
  world = position + offset;
  direction = normal;
  material = tint;
  gl_Position = viewProjection * vec4(world, 1.0);
}`;
const fragmentCode = `
precision mediump float;
uniform vec3 eye;
varying vec3 world;
varying vec3 direction;
varying vec3 material;
void main() {
  vec3 n = normalize(direction);
  vec3 view = normalize(eye - world);
  vec3 key = normalize(vec3(-0.44, 0.85, 0.30));
  vec3 fill = normalize(vec3(0.16, 0.09, 1.0));
  vec3 rim = normalize(vec3(0.5, 0.45, -0.7));
  float diffuse = max(dot(n, key), 0.0);
  float specular = pow(max(dot(n, normalize(key + view)), 0.0), 48.0);
  float outline = pow(max(0.0, 1.0 - abs(dot(n, view))), 2.3) * max(dot(n, rim), 0.0);
  vec3 shade = material * (0.31 + 0.65 * diffuse + 0.25 * max(dot(n, fill), 0.0));
  shade += material * vec3(0.50, 0.74, 0.85) * specular;
  shade += material * vec3(0.15, 0.43, 0.65) * outline;
  gl_FragColor = vec4(shade, 1.0);
}`;

const sum = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const diff = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec): Vec => scale(a, 1 / Math.hypot(...a));
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function snapPipePosition(position: number, step: number): number {
  return clamp(Math.round(position / step) * step, step, PIPE_LENGTH_M - step);
}

function cameraBasis(camera: Camera, aspect: number) {
  const tangent = Math.tan(FOV / 2);
  const extent = Math.min(1, aspect / 1.9);
  const distance = (10.3 / extent) * camera.zoom;
  const eye = sum(CENTRE, [
    distance * Math.sin(camera.yaw) * Math.cos(camera.pitch),
    distance * Math.sin(camera.pitch),
    distance * Math.cos(camera.yaw) * Math.cos(camera.pitch),
  ]);
  const back = unit(diff(eye, CENTRE));
  const right = unit(cross([0, 1, 0], back));
  const up = cross(back, right);
  return { eye, back, right, up, tangent };
}

function cameraMatrix(basis: ReturnType<typeof cameraBasis>, aspect: number) {
  const { eye, back, right, up, tangent } = basis;
  const xScale = 1 / (aspect * tangent);
  const yScale = 1 / tangent;
  const depthScale = -(FAR + NEAR) / (FAR - NEAR);
  const depthOffset = -(2 * FAR * NEAR) / (FAR - NEAR);
  return new Float32Array([
    right[0] * xScale, up[0] * yScale, back[0] * depthScale, -back[0],
    right[1] * xScale, up[1] * yScale, back[1] * depthScale, -back[1],
    right[2] * xScale, up[2] * yScale, back[2] * depthScale, -back[2],
    -dot(right, eye) * xScale, -dot(up, eye) * yScale, -dot(back, eye) * depthScale + depthOffset, dot(back, eye),
  ]);
}

export function projectPipeAnchors(camera: Camera, aspect: number, sensors: boolean, revealedPositionM: number | null) {
  const basis = cameraBasis(camera, aspect);
  function project(id: string, point: Vec) {
    const fromEye = diff(point, basis.eye);
    const depth = -dot(basis.back, fromEye);
    if (depth < NEAR || depth > FAR) return [];
    const size = 2 * depth * basis.tangent;
    const x = 0.5 + dot(basis.right, fromEye) / (size * aspect);
    const y = 0.5 - dot(basis.up, fromEye) / size;
    return [{ id, x, y }];
  }

  const reveal = revealedPositionM === null ? [] : project('leak', [positionX(revealedPositionM), ...REVEAL_TOP]);
  const stations = sensors ? PRESSURE_STATIONS.flatMap(({ label, locationM }) => project(label, [positionX(locationM), SENSOR_TOP, 0])) : [];
  return [...reveal, ...stations];
}

export function findPipePosition(camera: Camera, aspect: number, horizontal: number, vertical: number): number | null {
  const { eye, back, right, up, tangent } = cameraBasis(camera, aspect);
  const direction = unit(sum(sum(scale(back, -1), scale(right, horizontal * aspect * tangent)), scale(up, vertical * tangent)));
  const a = direction[1] ** 2 + direction[2] ** 2;
  const halfB = eye[1] * direction[1] + eye[2] * direction[2];
  const sideHits = [RADIUS, INNER_RADIUS].flatMap((radius) => {
    if (a <= 1e-10) return [];
    const c = eye[1] ** 2 + eye[2] ** 2 - radius ** 2;
    const discriminant = halfB ** 2 - a * c;
    if (discriminant < 0) return [];
    return [(-halfB - Math.sqrt(discriminant)) / a, (-halfB + Math.sqrt(discriminant)) / a]
      .filter((t) => t > 0 && Math.abs(eye[0] + t * direction[0]) <= HALF);
  });
  const endHits = Math.abs(direction[0]) > 1e-8
    ? [-HALF, HALF].map((x) => (x - eye[0]) / direction[0])
      .filter((t) => {
        const radialSquared = (eye[1] + t * direction[1]) ** 2 + (eye[2] + t * direction[2]) ** 2;
        return t > 0 && radialSquared >= INNER_RADIUS ** 2 && radialSquared <= RADIUS ** 2;
      })
    : [];
  const hit = Math.min(...sideHits, ...endHits);
  return Number.isFinite(hit) ? clamp((eye[0] + hit * direction[0] + HALF) / (2 * HALF), 0, 1) * PIPE_LENGTH_M : null;
}

export function orbitPipe(camera: Camera, dx: number, dy: number): Camera {
  return { ...camera, yaw: (camera.yaw - dx * 0.008) % (Math.PI * 2), pitch: clamp(camera.pitch + dy * 0.007, 0, 1.2) };
}

export function zoomPipe(camera: Camera, factor: number): Camera {
  return { ...camera, zoom: clamp(camera.zoom * factor, 0.69, 1.9) };
}

const vertex = (mesh: number[], p: Vec, n: Vec, tint: Vec) => mesh.push(...p, ...n, ...tint);

function shell(mesh: number[], x0: number, x1: number, radius: number, tint: Vec, inner = false) {
  const sides = 48;
  for (let i = 0; i < sides; i++) {
    const angle = i / sides * Math.PI * 2;
    const next = (i + 1) / sides * Math.PI * 2;
    const first: Vec = [0, Math.cos(angle), Math.sin(angle)];
    const last: Vec = [0, Math.cos(next), Math.sin(next)];
    const x: Vec = [x0, 0, 0];
    const y: Vec = [x1, 0, 0];
    const u = scale(first, radius);
    const v = scale(last, radius);
    const nn = scale(first, inner ? -1 : 1);
    const nm = scale(last, inner ? -1 : 1);
    vertex(mesh, sum(x, u), nn, tint);
    vertex(mesh, sum(y, u), nn, tint);
    vertex(mesh, sum(y, v), nm, tint);
    vertex(mesh, sum(x, u), nn, tint);
    vertex(mesh, sum(y, v), nm, tint);
    vertex(mesh, sum(x, v), nm, tint);
  }
}

function ring(mesh: number[], x: number, inner: number, outer: number, tint: Vec, reverse = false) {
  const normal: Vec = [reverse ? -1 : 1, 0, 0];
  for (let side = 0; side < 48; side++) {
    const position = (index: number, radius: number): Vec => [x, radius * Math.cos(index / 24 * Math.PI), radius * Math.sin(index / 24 * Math.PI)];
    const p = position(side, inner), q = position(side, outer);
    const r = position(side + 1, outer), s = position(side + 1, inner);
    for (const value of [p, q, r, p, r, s]) vertex(mesh, value, normal, tint);
  }
}

function box(mesh: number[], centre: Vec, half: Vec, tint: Vec) {
  const faces = [
    [0, 1, 2, [1, 0, 0]], [0, 1, 2, [-1, 0, 0]], [1, 2, 0, [0, 1, 0]],
    [1, 2, 0, [0, -1, 0]], [2, 0, 1, [0, 0, 1]], [2, 0, 1, [0, 0, -1]],
  ] as const;
  for (const [axis, u, v, normal] of faces) {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]] as const) {
      const point: [number, number, number] = [...centre];
      point[axis] += half[axis] * normal[axis];
      point[u] += half[u] * a;
      point[v] += half[v] * b;
      vertex(mesh, point, normal, tint);
    }
  }
}

function makeShell(): Mesh {
  const vertices: number[] = [];
  const steel: Vec = [0.35, 0.56, 0.69];
  const flange: Vec = [0.22, 0.34, 0.41];
  const edge: Vec = [0.56, 0.70, 0.76];
  shell(vertices, -HALF, HALF, RADIUS, steel);
  shell(vertices, -HALF, HALF, INNER_RADIUS, [0.09, 0.16, 0.21], true);
  for (const x of [-HALF + 0.12, -4.45, -2.22, 0, 2.22, 4.45, HALF - 0.12]) {
    const terminal = Math.abs(x) > 6;
    const radius = terminal ? 0.68 : 0.556;
    shell(vertices, x - 0.09, x + 0.09, radius, flange);
    ring(vertices, x - 0.09, RADIUS, radius, edge, true);
    ring(vertices, x + 0.09, RADIUS, radius, edge);
    if (!terminal) continue;
    for (let bolt = 0; bolt < 8; bolt++) {
      const angle = (bolt + 0.5) * Math.PI / 4;
      const y = 0.594 * Math.cos(angle);
      const z = 0.594 * Math.sin(angle);
      box(vertices, [x, y, z], [0.159, 0.033, 0.033], [0.77, 0.57, 0.28]);
    }
  }
  ring(vertices, -HALF, INNER_RADIUS, RADIUS, edge, true);
  ring(vertices, HALF, INNER_RADIUS, RADIUS, edge);
  for (const x of [-4.45, 0, 4.45]) {
    box(vertices, [x, -0.69, 0], [0.16, 0.32, 0.21], flange);
    box(vertices, [x, -1.05, 0], [0.37, 0.055, 0.53], [0.29, 0.44, 0.52]);
    for (const z of [-0.42, 0.42]) box(vertices, [x, -0.98, z], [0.06, 0.036, 0.06], edge);
  }
  box(vertices, [0, -1.32, 0], [7.05, 0.19, 1.75], [0.075, 0.13, 0.18]);
  box(vertices, [0, -1.47, 0], [7.14, 0.045, 1.81], [0.13, 0.24, 0.31]);
  for (const z of [-1.61, 1.61]) {
    box(vertices, [0, -1.11, z], [6.65, 0.018, 0.017], [0.18, 0.37, 0.44]);
  }
  for (const x of [-6.71, 6.71]) {
    box(vertices, [x, -1.11, 0], [0.065, 0.02, 1.6], [0.73, 0.54, 0.25]);
  }
  return { type: 'triangles', vertices };
}

function makeGrid(): Mesh {
  const vertices: number[] = [];
  const horizontal: Vec = [0, 1, 0];
  const line = (a: Vec, b: Vec, colour: Vec) => {
    vertex(vertices, a, horizontal, colour);
    vertex(vertices, b, horizontal, colour);
  };
  for (let x = -8; x <= 8; x += 0.5) line([x, -1.56, -4], [x, -1.56, 4], [0.10, 0.17, 0.23]);
  for (let z = -4; z <= 4; z += 0.5) line([-8, -1.56, z], [8, -1.56, z], [0.10, 0.17, 0.23]);
  const tick: Vec = [0.32, 0.63, 0.72];
  line([-HALF, -1.12, 1.46], [HALF, -1.12, 1.46], tick);
  for (let metre = 0; metre <= PIPE_LENGTH_M; metre += 50) {
    const x = positionX(metre);
    line([x, -1.12, 1.46], [x, -1.12, metre % 250 === 0 ? 1.22 : 1.35], tick);
  }
  for (let x = -5.5; x <= 5.5; x += 1.1) {
    const tint: Vec = [0.31, 0.62, 0.71];
    line([x - 0.18, -1.11, -1.11], [x + 0.18, -1.11, -1.11], tint);
    line([x + 0.18, -1.11, -1.11], [x + 0.07, -1.11, -0.98], tint);
    line([x + 0.18, -1.11, -1.11], [x + 0.07, -1.11, -1.24], tint);
  }
  return { type: 'lines', vertices };
}

function makeSensors(): Mesh {
  const vertices: number[] = [];
  for (const { locationM, tint } of PRESSURE_STATIONS) {
    const x = positionX(locationM);
    box(vertices, [x, 0.66, 0], [0.055, 0.18, 0.066], [0.29, 0.41, 0.49]);
    box(vertices, [x, 0.94, 0], [0.15, 0.1, 0.13], tint);
    box(vertices, [x, SENSOR_TOP - 0.031, 0], [0.081, 0.031, 0.075], tint);
  }
  return { type: 'triangles', vertices };
}

function marker(tint: Vec, revealed = false): Mesh {
  const vertices: number[] = [];
  shell(vertices, -0.047, 0.047, RADIUS + 0.068, tint);
  ring(vertices, -0.047, RADIUS, RADIUS + 0.068, tint, true);
  ring(vertices, 0.047, RADIUS, RADIUS + 0.068, tint);
  box(vertices, [0, 0.56, 0.42], [0.037, 0.18, 0.038], tint);
  box(vertices, [0, 0.76, 0.42], [0.077, 0.07, 0.077], tint);
  if (revealed) {
    box(vertices, [0, (REVEAL_TOP[0] + 0.39) / 2, REVEAL_TOP[1]], [0.019, (REVEAL_TOP[0] - 0.39) / 2, 0.019], tint);
    for (const x of [-0.17, 0.17]) {
      ring(vertices, x, RADIUS + 0.11, RADIUS + 0.15, tint, true);
      ring(vertices, x, RADIUS + 0.11, RADIUS + 0.15, tint);
    }
  }
  return { type: 'triangles', vertices };
}

function shader(gl: WebGLRenderingContext, type: number, source: string) {
  const instance = gl.createShader(type);
  if (!instance) throw new Error('Cannot allocate WebGL shader');
  gl.shaderSource(instance, source);
  gl.compileShader(instance);
  if (!gl.getShaderParameter(instance, gl.COMPILE_STATUS)) {
    gl.deleteShader(instance);
    throw new Error('Unable to compile pipe shaders');
  }
  return instance;
}

function createProgram(gl: WebGLRenderingContext) {
  const program = gl.createProgram();
  if (!program) throw new Error('Cannot allocate WebGL program');
  let vertexShader: WebGLShader | undefined;
  let fragmentShader: WebGLShader | undefined;
  try {
    vertexShader = shader(gl, gl.VERTEX_SHADER, vertexCode);
    fragmentShader = shader(gl, gl.FRAGMENT_SHADER, fragmentCode);
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Unable to link pipe shaders');
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
  }
}

export function createPipeRenderer(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('webgl', { alpha: true, antialias: true, depth: true });
  if (!context) return null;
  const gl = context;
  const program = createProgram(gl);
  const meshes: { buffer: WebGLBuffer; count: number; type: number }[] = [];
  try {
    for (const mesh of [makeGrid(), makeShell(), makeSensors(), marker([1, 0.64, 0.26]), marker([1, 0.42, 0.28], true)]) {
      const buffer = gl.createBuffer();
      if (!buffer) throw new Error('Cannot allocate mesh buffer');
      meshes.push({ buffer, count: mesh.vertices.length / 9, type: mesh.type === 'triangles' ? gl.TRIANGLES : gl.LINES });
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.vertices), gl.STATIC_DRAW);
    }
  } catch (error) {
    meshes.forEach(({ buffer }) => gl.deleteBuffer(buffer));
    gl.deleteProgram(program);
    throw error;
  }
  const attributes = ['position', 'normal', 'tint'].map((name) => gl.getAttribLocation(program, name));
  const projection = gl.getUniformLocation(program, 'viewProjection');
  const origin = gl.getUniformLocation(program, 'offset');
  const eyeUniform = gl.getUniformLocation(program, 'eye');
  gl.useProgram(program);
  gl.enable(gl.DEPTH_TEST);
  attributes.forEach((attribute) => gl.enableVertexAttribArray(attribute));

  function draw(camera: Camera, appearance: Appearance) {
    if (gl.isContextLost()) return;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(bounds.width * pixelRatio));
    const height = Math.max(1, Math.round(bounds.height * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const aspect = bounds.width / bounds.height;
    const basis = cameraBasis(camera, aspect);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(projection, false, cameraMatrix(basis, aspect));
    gl.uniform3fv(eyeUniform, basis.eye);
    const indexOfMarker = appearance.revealed ? 4 : 3;
    for (const [index, mesh] of meshes.entries()) {
      if (index === 2 && !appearance.sensors) continue;
      if (index > 2 && (appearance.positionM === null || index !== indexOfMarker)) continue;
      const x = index > 2 ? positionX(appearance.positionM ?? 0) : 0;
      gl.uniform3f(origin, x, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
      attributes.forEach((location, attribute) => gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 36, attribute * 12));
      gl.drawArrays(mesh.type, 0, mesh.count);
    }
  }

  return {
    draw,
    dispose() {
      meshes.forEach(({ buffer }) => gl.deleteBuffer(buffer));
      gl.deleteProgram(program);
    },
  };
}
