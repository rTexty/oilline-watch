// Packed nominal isothermal MOC, derived from the measured oil-backends GPU shader.
// One independent workgroup per hypothesis; all traces require an F64 recheck.
override WIDTH: u32 = 128u;
const NODES = 201u;
const DT = 0.005;
const RHO = 850.0;
const WAVE_SPEED = 1000.0;
const DIAMETER = 0.2;
const AREA = 0.031415926535897934;
const NU = 0.00001;
const ROUGHNESS = 0.000225;
const PIN = 1200000.0;
const PEXT_OFFSET = 101325.0 - PIN;
const Q0 = AREA * 0.8;
const Z = RHO * WAVE_SPEED / AREA;
const MIN_FLOW = 4000.0 * NU / DIAMETER * AREA;
const MAX_FLOW = 1e8 * NU / DIAMETER * AREA;

struct Hypothesis {
  node: u32,
  onsetStep: u32,
  rampSteps: u32,
  cdA: f32,
}

struct Config {
  steps: u32,
  stride: u32,
  firstSampleStep: u32,
  lastSampleStep: u32,
}

struct Node {
  pressure: f32,
  leftFlow: f32,
  rightFlow: f32,
}

@group(0) @binding(0) var<storage, read> candidates: array<Hypothesis>;
@group(0) @binding(1) var<uniform> config: Config;
@group(0) @binding(2) var<storage, read_write> traces: array<f32>;
@group(0) @binding(3) var<storage, read> checkpoint: array<Node>;
@group(0) @binding(4) var<storage, read_write> invalid: array<atomic<u32>>;

var<workgroup> fromLeft: array<f32, NODES>;
var<workgroup> fromRight: array<f32, NODES>;

fn quarticUpdate(z: f32, x1: f32, x2: f32) -> f32 {
  let sum = x1 + z;
  let e = (z + log(sum) - x2) / (1.0 + sum);
  return z - ((1.0 + sum + e / 2.0) * e * sum) / (1.0 + sum + e + e * e / 3.0);
}

fn friction(q: f32) -> f32 {
  let u = q / AREA;
  let re = abs(u) * DIAMETER / NU;
  let ln10 = 2.302585092994046;
  let x1 = ln10 * ROUGHNESS * re / 18.574;
  let x2 = log(ln10 * re / 5.02);
  let z = quarticUpdate(quarticUpdate(x2 - 0.2, x1, x2), x1, x2);
  let rootF = ln10 / (2.0 * z);
  return rootF * rootF * u * abs(u) / (2.0 * DIAMETER);
}

fn initial(i: u32) -> Node {
  if i < NODES { return checkpoint[i]; }
  return Node(0.0, 0.0, 0.0);
}

fn emit(i: u32, state: Node) {
  let leftLoss = RHO * WAVE_SPEED * DT * friction(state.leftFlow);
  var rightLoss = leftLoss;
  if state.leftFlow != state.rightFlow {
    rightLoss = RHO * WAVE_SPEED * DT * friction(state.rightFlow);
  }
  if i + 1u < NODES {
    fromLeft[i + 1u] = state.pressure + Z * state.rightFlow - rightLoss;
  }
  if i > 0u {
    fromRight[i - 1u] = state.pressure - Z * state.leftFlow + leftLoss;
  }
}

fn opening(step: u32, h: Hypothesis) -> f32 {
  if step < h.onsetStep { return 0.0; }
  if h.rampSteps == 0u { return h.cdA; }
  return h.cdA * min(1.0, f32(step - h.onsetStep) / f32(h.rampSteps));
}

fn advance(i: u32, leakNode: u32, k: f32) -> Node {
  if i == 0u {
    let q = -fromRight[0u] / Z;
    return Node(0.0, q, q);
  }
  if i + 1u == NODES {
    return Node(fromLeft[i] - Z * Q0, Q0, Q0);
  }
  let cp = fromLeft[i];
  let cm = fromRight[i];
  let p = (cp + cm) * 0.5;
  let q = (cp - cm) * (0.5 / Z);
  if i == leakNode && k > 0.0 {
    let a = 2.0 / Z;
    let b = k * sqrt(2.0 / RHO);
    let c = (cp + cm - 2.0 * PEXT_OFFSET) / Z;
    let z = 2.0 * c / (b + sqrt(b * b + 4.0 * a * c));
    let halfLeak = b * z * 0.5;
    // Algebraically equivalent to pJ = pExt + z², with better f32 conditioning.
    return Node(p - Z * halfLeak, q + halfLeak, q - halfLeak);
  }
  return Node(p, q, q);
}

fn reportInvalid(i: u32, state: Node, candidate: u32) {
  if i >= NODES { return; }
  let p = state.pressure + PIN;
  if !(p >= 250000.0 && p <= 2000000.0 && state.leftFlow >= MIN_FLOW && state.leftFlow <= MAX_FLOW
       && state.rightFlow >= MIN_FLOW && state.rightFlow <= MAX_FLOW) {
    atomicStore(&invalid[candidate], 1u);
  }
}

fn sample(i: u32, state: Node, offset: u32) {
  switch i {
    case 0u: { traces[offset + 3u] = state.leftFlow; }
    case 20u: { traces[offset] = state.pressure + PIN; }
    case 100u: { traces[offset + 1u] = state.pressure + PIN; }
    case 180u: { traces[offset + 2u] = state.pressure + PIN; }
    default: {}
  }
}

@compute @workgroup_size(WIDTH)
fn simulate(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3<u32>) {
  let h = candidates[group.x];
  let other = lane + WIDTH;
  var x = initial(lane);
  var y = initial(other);
  let base = group.x * config.stride;
  if config.firstSampleStep == 0u {
    sample(lane, x, base);
    sample(other, y, base);
  }

  for (var step = 0u; step < config.steps; step++) {
    let k = opening(step, h);
    if lane < NODES { emit(lane, x); }
    if other < NODES { emit(other, y); }
    workgroupBarrier();
    if lane < NODES { x = advance(lane, h.node, k); }
    if other < NODES { y = advance(other, h.node, k); }
    workgroupBarrier();
    reportInvalid(lane, x, group.x);
    reportInvalid(other, y, group.x);
    let completed = step + 1u;
    if completed >= config.firstSampleStep && completed <= config.lastSampleStep
       && (completed - config.firstSampleStep) % 2u == 0u {
      let offset = base + ((completed - config.firstSampleStep) / 2u) * 4u;
      sample(lane, x, offset);
      sample(other, y, offset);
    }
  }
}
