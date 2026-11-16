struct Config {
  segmentCount: u32,
  thresholdCount: u32,
}

const SCENARIO_COUNT = 7u;
const WORKGROUP_SIZE = 64u;
@group(0) @binding(0) var<uniform> config: Config;
@group(0) @binding(1) var<storage, read> thickness: array<u32>;
@group(0) @binding(2) var<storage, read> thresholds: array<u32>;
@group(0) @binding(3) var<storage, read_write> results: array<u32>;

@compute @workgroup_size(WORKGROUP_SIZE)
fn aggregate(
  @builtin(global_invocation_id) invocation: vec3<u32>,
  @builtin(num_workgroups) workgroups: vec3<u32>,
) {
  let index = invocation.x + invocation.y * workgroups.x * WORKGROUP_SIZE;
  if (index >= config.segmentCount * config.thresholdCount) {
    return;
  }
  let segment = index % config.segmentCount;
  let thresholdIndex = index / config.segmentCount;
  let threshold = thresholds[thresholdIndex];
  let start = segment * SCENARIO_COUNT;
  var sum = 0u;
  var below = 0u;
  for (var scenario = 0u; scenario < SCENARIO_COUNT; scenario++) {
    let value = thickness[start + scenario];
    sum += value;
    below += select(0u, 1u, value < threshold);
  }
  if (thresholdIndex == 0u) {
    results[segment] = sum;
  }
  results[config.segmentCount + index] = below;
}
