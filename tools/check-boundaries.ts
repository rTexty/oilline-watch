import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const runtimeDependencies = new Set(['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'zod'])
const threeImporters = new Set(['src/walk/runtime.ts', 'src/walk/world.ts'])

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(file)
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : []
  })
}

function inspect(source: ts.SourceFile, from: string, errors: string[]): string[] {
  const specifiers: string[] = []
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      specifiers.push(node.argument.literal.text)
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const name = node.moduleReference.expression
      if (name && ts.isStringLiteral(name)) specifiers.push(name.text)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const name = node.arguments[0]
      if (from === 'src/walk/WalkDialog.tsx' && name && ts.isStringLiteral(name) && name.text === './runtime') specifiers.push(name.text)
      else errors.push(`${source.fileName}: dynamic import is outside the allowlist`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

function normalize(file: string) {
  return file.split(sep).join('/').replaceAll('\\', '/').split('?')[0] ?? ''
}

export function forbiddenModule(path: string, inference: boolean): boolean {
  const file = normalize(path)
  if (/(^|\/)(validation|reference|docs|tools)\//.test(file)) return true
  if (!inference) return false
  return /(^|\/)src\/(plant\/|evaluation\/|app\/|ui\/|walk\/|contracts\/private-scenario\b|runtime\/(engine\b|simulation\.worker\b|replay\b|vertical-protocol\b))/.test(file)
}

function forbiddenMainModule(file: string): boolean {
  return /^src\/((physics|plant|twin|detection|evaluation)\/|contracts\/private-scenario\b|runtime\/(engine|replay|simulation\.worker|inference\.worker)\.)/.test(file)
}

export function checkBoundaries(root: string): string[] {
  const errors: string[] = []
  const files = sourceFiles(join(root, 'src'))
  const configPath = join(root, 'tsconfig.app.json')
  const options = existsSync(configPath)
    ? ts.getParsedCommandLineOfConfigFile(configPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => errors.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    })?.options ?? {}
    : { moduleResolution: ts.ModuleResolutionKind.Bundler, resolveJsonModule: true }
  const dependencies = new Map<string, string[]>()
  for (const file of files) {
    const from = normalize(relative(root, file))
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const edges: string[] = []
    for (const specifier of inspect(source, from, errors)) {
      if (runtimeDependencies.has(specifier) || (specifier === 'three' && threeImporters.has(from))) continue
      if (from === 'src/walk/world.ts' && specifier === 'three/addons/utils/BufferGeometryUtils.js') continue
      const plain = specifier.split('?')[0] ?? specifier
      const target = ts.resolveModuleName(plain, file, options, ts.sys).resolvedModule?.resolvedFileName
        ?? (plain.startsWith('.') ? resolve(dirname(file), plain) : plain.startsWith('/') ? resolve(root, `.${plain}`) : null)
      if (!target || !isAbsolute(target)) {
        errors.push(`${relative(root, file)}: unresolved production import ${specifier}`)
        continue
      }
      const path = normalize(relative(root, target))
      if (!path.startsWith('src/') || forbiddenModule(path, false)) {
        errors.push(`${relative(root, file)}: forbidden production import ${specifier}`)
      }
      if (from.startsWith('src/physics/') && path !== 'src/profiles/zielke-coefficients.json'
        && !/^src\/(physics\/|contracts\/model\.)/.test(path)) {
        errors.push(`${from}: forbidden physics import ${specifier}`)
      }
      if (/^src\/(app|ui|walk)\//.test(from) && forbiddenMainModule(path)) {
        errors.push(`${from}: forbidden main-thread import ${specifier}`)
      }
      edges.push(target)
    }
    dependencies.set(file, edges)
  }

  const seen = new Set<string>()
  function walk(file: string) {
    if (seen.has(file)) return
    seen.add(file)
    const path = normalize(relative(root, file))
    if (forbiddenModule(path, true)) errors.push(`public inference/twin dependency: ${path}`)
    for (const target of dependencies.get(file) ?? []) walk(target)
  }
  for (const file of files) {
    const path = normalize(relative(root, file))
    if (/^src\/(runtime\/inference\.worker\.|detection\/|twin\/)/.test(path)) walk(file)
  }

  const mainSeen = new Set<string>()
  function walkMain(file: string) {
    if (mainSeen.has(file)) return
    mainSeen.add(file)
    const path = normalize(relative(root, file))
    if (forbiddenMainModule(path)) errors.push(`public main dependency: ${path}`)
    for (const target of dependencies.get(file) ?? []) walkMain(target)
  }
  for (const file of files) {
    if (/^src\/(main\.|app\/|ui\/|walk\/)/.test(normalize(relative(root, file)))) walkMain(file)
  }
  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = checkBoundaries(process.cwd())
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  }
}
