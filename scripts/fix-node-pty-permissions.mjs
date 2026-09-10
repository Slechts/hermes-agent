import { chmodSync, lstatSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64'])

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate)

  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

function nodePtyEntryExists(requireFromProject, projectRoot) {
  const searchPaths = requireFromProject.resolve.paths('node-pty/package.json') ?? []

  return searchPaths.some(searchPath => {
    const candidate = path.join(searchPath, 'node-pty')
    if (!isWithin(projectRoot, candidate)) return false

    try {
      lstatSync(candidate)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  })
}

function assertRegularFile(filePath, label) {
  const stat = lstatSync(filePath)

  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`)
  }
  return stat
}

function assertNoSymlinkComponents(packageRoot, filePath) {
  const relative = path.relative(packageRoot, filePath)

  if (!isWithin(packageRoot, filePath)) {
    throw new Error(`node-pty path escapes its package: ${filePath}`)
  }

  let current = packageRoot
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component)
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`node-pty path contains a symlink: ${current}`)
    }
  }
}

export function repairNodePtyPermissions({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'darwin' || !SUPPORTED_ARCHITECTURES.has(arch)) return

  const projectRoot = realpathSync(process.cwd())
  const requireFromProject = createRequire(path.join(projectRoot, 'package.json'))
  let packageJsonPath

  try {
    packageJsonPath = requireFromProject.resolve('node-pty/package.json')
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND' && !nodePtyEntryExists(requireFromProject, projectRoot)) return
    throw new Error('node-pty is present but its package manifest cannot be resolved', { cause: error })
  }

  const packageRoot = realpathSync(path.dirname(packageJsonPath))
  if (!isWithin(projectRoot, packageRoot)) {
    if (!nodePtyEntryExists(requireFromProject, projectRoot)) return
    throw new Error(`Resolved node-pty package is outside the project: ${packageRoot}`)
  }

  const utilsPath = path.join(packageRoot, 'lib', 'utils.js')
  assertNoSymlinkComponents(packageRoot, utilsPath)
  assertRegularFile(utilsPath, 'node-pty native loader')

  const layouts = ['build/Release', 'build/Debug', `prebuilds/darwin-${arch}`]
  const supportedDirectories = layouts.map(layout => path.join(packageRoot, layout))

  // The upstream loader can execute either parent-relative or lib-relative candidates.
  // Validate both sets before it can require any native code, including fallback paths.
  for (const base of [packageRoot, path.dirname(utilsPath)]) {
    for (const layout of layouts) {
      const directory = path.join(base, layout)
      const nativePath = path.join(directory, 'pty.node')

      try {
        assertNoSymlinkComponents(packageRoot, directory)
        if (!lstatSync(directory).isDirectory()) {
          throw new Error(`node-pty native directory must be a directory: ${directory}`)
        }
        assertNoSymlinkComponents(packageRoot, nativePath)
        assertRegularFile(nativePath, 'node-pty native module')
        if (!isWithin(packageRoot, realpathSync(nativePath))) {
          throw new Error(`node-pty native module escapes its package: ${nativePath}`)
        }
      } catch (error) {
        // Missing candidates are normal: the upstream loader tries the next layout.
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }

  const { loadNativeModule } = requireFromProject(utilsPath)
  if (typeof loadNativeModule !== 'function') {
    throw new Error(`node-pty native loader is invalid: ${utilsPath}`)
  }

  const native = loadNativeModule('pty')
  const selectedDirectory = path.resolve(path.dirname(utilsPath), native?.dir ?? '')

  if (!supportedDirectories.includes(selectedDirectory)) {
    throw new Error(`node-pty selected an unsupported native directory: ${selectedDirectory}`)
  }

  const nativeModulePath = path.join(selectedDirectory, 'pty.node')
  const helperPath = path.join(selectedDirectory, 'spawn-helper')

  assertNoSymlinkComponents(packageRoot, nativeModulePath)
  assertRegularFile(nativeModulePath, 'node-pty native module')
  assertNoSymlinkComponents(packageRoot, helperPath)
  const helperStat = assertRegularFile(helperPath, 'node-pty spawn-helper')
  const realHelperPath = realpathSync(helperPath)

  if (!isWithin(packageRoot, realHelperPath)) {
    throw new Error(`node-pty spawn-helper escapes its package: ${helperPath}`)
  }
  if ((helperStat.mode & 0o7777) !== 0o755) chmodSync(helperPath, 0o755)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  repairNodePtyPermissions()
}
