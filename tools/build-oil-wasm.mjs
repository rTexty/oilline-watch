import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crate = join(root, 'rust/oil-kernel');
const output = join(root, 'src/generated/oil');
const target = 'wasm32-unknown-unknown';
const toolchain = '1.99.1';
const memoryLimitBytes = 2 * 1024 * 1024;

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: crate, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} exited ${result.status}`);
  return result.stdout.trim();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sources() {
  const files = ['Cargo.lock', 'Cargo.toml', 'rust-toolchain.toml', ...readdirSync(join(crate, 'src'))
    .filter((name) => name.endsWith('.rs')).map((name) => `src/${name}`)].sort();
  return Object.fromEntries(files.map((path) => [path, sha256(readFileSync(join(crate, path)))]));
}

async function buildVariant(directory, variant) {
  const cargoTarget = join(directory, variant);
  const feature = variant === 'simd' ? '+simd128' : '-simd128';
  const flags = [`-Ctarget-feature=${feature}`, `-Clink-arg=--max-memory=${memoryLimitBytes}`];
  // Encoded flags prevent an ambient RUSTFLAGS or Cargo config from replacing the ABI flags.
  run('cargo', [`+${toolchain}`, 'rustc', '--release', '--locked', '--offline', '--target', target, '--', '--emit=asm,link'], {
    ...process.env,
    CARGO_TARGET_DIR: cargoTarget,
    CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f'),
  });
  const compiled = join(cargoTarget, target, 'release');
  const wasm = readFileSync(join(compiled, 'pipetwin_oil_kernel.wasm'));
  const assemblyFile = readdirSync(join(compiled, 'deps')).find((name) => name.endsWith('.s'));
  if (!assemblyFile) throw new Error(`Missing ${variant} assembly`);
  const assembly = readFileSync(join(compiled, 'deps', assemblyFile), 'utf8');
  const simdArithmetic = /f64x2\.(add|sub|mul|div)/.test(assembly);
  if (simdArithmetic !== (variant === 'simd')) throw new Error(`Unexpected SIMD instructions for ${variant}`);
  if (variant === 'simd' && !/i64x2\.shr_u/.test(assembly)) throw new Error('SIMD Clamond logarithm missing');
  const { instance } = await WebAssembly.instantiate(wasm);
  const exports = instance.exports;
  if (exports.kernel_version() !== 1 || exports.kernel_variant() !== (variant === 'simd' ? 2 : 1)
    || exports.workspace_words() !== 7 * 401 + 1 || !(exports.memory instanceof WebAssembly.Memory)
    || exports.memory.buffer.byteLength > memoryLimitBytes) throw new Error(`Invalid ${variant} kernel exports`);
  return { wasm, flags };
}

async function main() {
  const version = run('rustc', [`+${toolchain}`, '--version']);
  if (!version.startsWith(`rustc ${toolchain} `)) throw new Error(`Expected Rust ${toolchain}, found ${version}`);
  const directory = mkdtempSync(join(tmpdir(), 'pipetwin-oil-wasm-'));
  try {
    const sourceHashes = sources();
    const variants = [];
    for (const variant of ['scalar', 'simd']) {
      const { wasm, flags } = await buildVariant(directory, variant);
      variants.push({ variant, wasm, flags });
    }
    if (JSON.stringify(sourceHashes) !== JSON.stringify(sources())) throw new Error('Kernel sources changed during build');
    const manifest = {
      schemaVersion: 1, abiVersion: 1, toolchain: version, target, memoryLimitBytes,
      sourceSha256: sha256(JSON.stringify(sourceHashes)), sourceHashes,
      variants: Object.fromEntries(variants.map(({ variant, wasm, flags }) => [variant, {
        file: `${variant}-polylog.wasm`, sha256: sha256(wasm), byteLength: wasm.length, flags,
      }])),
    };
    mkdirSync(output, { recursive: true });
    for (const { variant, wasm } of variants) {
      const file = manifest.variants[variant].file;
      const staged = join(output, `.${file}.${process.pid}`);
      writeFileSync(staged, wasm, { flag: 'wx' });
      renameSync(staged, join(output, file));
    }
    const stagedManifest = join(output, `.manifest.json.${process.pid}`);
    writeFileSync(stagedManifest, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    renameSync(stagedManifest, join(output, 'manifest.json'));
    console.log(`Built and verified scalar and SIMD ABI v1 oil kernels in ${output}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(`Oil WASM build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
