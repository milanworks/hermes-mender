/**
 * Hermes Mender
 *
 * Repairs Desktop halves of catalog-installed unified plugins when Hermes Desktop
 * is connected to a remote gateway. Uses the backend's installed SHA, never branch
 * HEAD, and never force-replaces an existing Desktop plugin.
 */
import { host, atom, useValue, Button, ROUTES_AREA, STATUSBAR_AREAS, PALETTE_AREA } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-mender'
const VERSION = '0.7.0-dev'
const CHECK_MS = 20000
let timer = null
let running = false
let lastRun = null
let directoryWatchId = null
let stopDirectoryEvents = null
const probeCache = new Map()
const SECURITY_MODES = new Set(['smart', 'strict', 'off'])
const CORE_PROTECTION_MODES = new Set(['smart', 'strict', 'off'])
const securityMode = atom('smart')
const coreProtectionMode = atom('smart')
const coreVersionApprovals = atom({})
const respectUninstallIntent = atom(true)
const autoEnableRepairedAgents = atom(false)
const operationBusy = atom(false)
const installIdentifier = atom('')
const installEnableAfter = atom(false)
const installState = atom({
  status: 'idle',
  message: '',
  identity: null,
  sha: null,
  probe: null,
  canApproveCore: false,
  reviewFindings: []
})
const compatibilityState = atom({
  status: 'checking',
  checkedAt: null,
  summary: 'Compatibility has not been checked yet.',
  checks: []
})
const UNINSTALL_TOMBSTONE_TTL_MS = 10 * 60 * 1000
const COMPATIBILITY_CACHE_MS = 60 * 1000
let compatibilityLastCheckedAt = 0
let stopConnectionApplied = null
let pluginStorage = null

function evaluateCompatibilityChecks(checks) {
  const rows = Array.isArray(checks) ? checks : []
  const requiredFailures = rows.filter(check => check.required && !check.ok)
  const optionalFailures = rows.filter(check => !check.required && !check.ok)

  if (requiredFailures.length) {
    return {
      status: 'unsupported',
      summary:
        'Required Hermes APIs are missing: ' +
        requiredFailures.map(check => check.label).join(', ') +
        '. Automatic Mender mutations are paused.'
    }
  }

  if (optionalFailures.length) {
    return {
      status: 'degraded',
      summary:
        'Mender can run, but some features use fallbacks or are unavailable: ' +
        optionalFailures.map(check => check.label).join(', ') +
        '.'
    }
  }

  return {
    status: 'compatible',
    summary: 'All Hermes APIs required by this Mender build are available.'
  }
}

async function checkCompatibility(force = false) {
  const now = Date.now()
  const current = compatibilityState.get()

  if (
    !force &&
    current?.status !== 'checking' &&
    now - compatibilityLastCheckedAt < COMPATIBILITY_CACHE_MS
  ) {
    return current
  }

  const desktop = window.hermesDesktop
  const checks = []
  const add = (id, label, ok, required, detail = '') =>
    checks.push({ id, label, ok: Boolean(ok), required: Boolean(required), detail })

  add('desktop.bridge', 'Desktop bridge', Boolean(desktop), true)
  add('desktop.root', 'desktopPluginsRoot()', typeof desktop?.desktopPluginsRoot === 'function', true)
  add('desktop.readDir', 'readDir()', typeof desktop?.readDir === 'function', true)
  add(
    'desktop.readText',
    'readFileText()/readPluginSource()',
    typeof desktop?.readFileText === 'function' || typeof desktop?.readPluginSource === 'function',
    true
  )

  add('desktop.probe', 'probePluginRepo()', typeof desktop?.probePluginRepo === 'function', false)
  add('desktop.install', 'installDesktopPlugin()', typeof desktop?.installDesktopPlugin === 'function', false)
  add('desktop.write', 'writeTextFile()', typeof desktop?.writeTextFile === 'function', false)
  add('desktop.trash', 'trashPath()', typeof desktop?.trashPath === 'function', false)
  add('desktop.rename', 'renamePath()', typeof desktop?.renamePath === 'function', false)
  add(
    'desktop.watch',
    'native directory watch',
    typeof desktop?.watchDirectory === 'function' && typeof desktop?.onPreviewFileChanged === 'function',
    false,
    'The 20-second reconcile timer remains as fallback.'
  )
  add(
    'desktop.reconcile',
    'reconcileDesktopPlugins()',
    typeof desktop?.reconcileDesktopPlugins === 'function',
    false
  )
  add(
    'desktop.remove',
    'removeDesktopPlugin()',
    typeof desktop?.removeDesktopPlugin === 'function',
    false,
    'Mender can fall back to trashPath for supported local cases.'
  )

  try {
    const response = await host.request('plugins.manage', { action: 'list' })
    const rows = Array.isArray(response?.plugins) ? response.plugins : null
    add('gateway.plugins.list', 'plugins.manage list', Boolean(rows), true)

    if (rows) {
      const userRows = rows.filter(row => row?.source !== 'bundled')
      const shapeOk =
        !userRows.length ||
        userRows.every(row => typeof row?.name === 'string' && typeof row?.status === 'string')
      add(
        'gateway.plugins.shape',
        'plugin row contract',
        shapeOk,
        true,
        'Mender needs plugin name/status fields from the active gateway.'
      )

      const unifiedRows = userRows.filter(row => row?.has_desktop_half)
      const unifiedShapeOk =
        !unifiedRows.length ||
        unifiedRows.every(row => typeof row?.key === 'string' && row?.key && row?.name)
      add(
        'gateway.plugins.keys',
        'canonical plugin keys',
        unifiedShapeOk,
        false,
        'Per-plugin enable/disable actions need the gateway-provided canonical key.'
      )
    }
  } catch (error) {
    add(
      'gateway.plugins.list',
      'plugins.manage list',
      false,
      true,
      error instanceof Error ? error.message : String(error)
    )
  }

  const verdict = evaluateCompatibilityChecks(checks)
  const next = {
    ...verdict,
    checkedAt: new Date().toISOString(),
    checks
  }

  compatibilityLastCheckedAt = now
  compatibilityState.set(next)
  return next
}

function compatibilityAllowsMutations() {
  return compatibilityState.get()?.status !== 'unsupported'
}

function freshState() {
  return {
    version: VERSION,
    running: false,
    at: null,
    reason: null,
    error: null,
    missing: 0,
    halves: [],
    findings: [],
    actions: []
  }
}

const menderState = atom(freshState())

function log(...args) {
  console.log('[hermes-mender]', ...args)
}

function warn(...args) {
  console.warn('[hermes-mender]', ...args)
}

function separator(path) {
  return path.includes('\\') ? '\\' : '/'
}

function joinPath(root, ...parts) {
  const sep = separator(root)
  return [root.replace(/[\\/]+$/, ''), ...parts.map(p => String(p).replace(/^[\\/]+|[\\/]+$/g, ''))].join(sep)
}
function parentPath(path) {
  return String(path).replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '')
}

function baseName(path) {
  return String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
}

function extractPluginId(source) {
  const direct = String(source).match(/(?:const|let|var)\s+(?:PLUGIN_)?ID\s*=\s*["']([^"']+)["']/)
  if (direct) return direct[1]

  const pluginObject = String(source).match(
    /(?:const|let|var)\s+[A-Za-z0-9_$]*plugin[A-Za-z0-9_$]*\s*=\s*\{[\s\S]{0,800}?\bid\s*:\s*["']([^"']+)["']/i
  )
  if (pluginObject) return pluginObject[1]

  const exported = String(source).match(
    /export\s+default\s*\{[\s\S]{0,800}?\bid\s*:\s*["']([^"']+)["']/i
  )
  return exported?.[1] || null
}

const SECURITY_RULES = [
  { id: 'MND001', severity: 'critical', label: 'dynamic eval', re: /\beval\s*\(/g },
  { id: 'MND002', severity: 'critical', label: 'dynamic Function constructor', re: /\bnew\s+Function\s*\(/g },
  { id: 'MND003', severity: 'critical', label: 'embedded private key material', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { id: 'MND101', severity: 'high', label: 'gateway shell execution', re: /host\.request\s*\(\s*["']shell\.exec["']/g },
  { id: 'MND102', severity: 'high', label: 'gateway CLI execution', re: /host\.request\s*\(\s*["']cli\.exec["']/g },
  { id: 'MND103', severity: 'high', label: 'process execution library', re: /\b(?:child_process|subprocess|os\.system)\b/g },
  { id: 'MND104', severity: 'high', label: 'desktop file mutation', re: /\.(?:writeTextFile|trashPath|removeDesktopPlugin|renamePath)\s*\(/g },
  { id: 'MND105', severity: 'high', label: 'desktop plugin installation', re: /\.installDesktopPlugin\s*\(/g },
  { id: 'MND201', severity: 'medium', label: 'network request', re: /\b(?:fetch|WebSocket|requests|httpx|aiohttp)\b/g },
  { id: 'MND202', severity: 'medium', label: 'environment access', re: /\b(?:process\.env|os\.environ|getenv)\b/g },
  { id: 'MND203', severity: 'medium', label: 'clipboard access', re: /\.(?:readClipboard|writeClipboard)\s*\(/g },
  { id: 'MND204', severity: 'medium', label: 'external URL open', re: /\.openExternal\s*\(/g }
]

function lineForOffset(source, offset) {
  return String(source).slice(0, Math.max(0, offset)).split('\n').length
}

function scanSource(source, file = 'plugin.js') {
  const text = String(source || '')
  const findings = []

  for (const rule of SECURITY_RULES) {
    rule.re.lastIndex = 0
    let match
    while ((match = rule.re.exec(text)) && findings.length < 60) {
      findings.push({
        id: rule.id,
        severity: rule.severity,
        label: rule.label,
        file,
        line: lineForOffset(text, match.index)
      })
      if (!match[0].length) rule.re.lastIndex += 1
    }
  }

  return findings
}

function hasBlockingFinding(findings, mode = securityMode.get()) {
  if (mode === 'off') return false
  if (mode === 'strict') {
    return (findings || []).some(finding => finding.severity === 'critical' || finding.severity === 'high')
  }
  return (findings || []).some(finding => finding.severity === 'critical')
}

const CORE_PATH_RE = /(?:\/usr\/local\/lib\/hermes-agent|[\\/]hermes-agent[\\/](?:hermes_cli|agent|tools|gateway|tui_gateway|apps[\\/]desktop)|site-packages[\\/](?:hermes_cli|agent|tools|gateway|tui_gateway))/i
const CORE_MUTATION_RE = /(?:write_text|write_bytes|open\s*\([^\n]{0,80}["'](?:w|a|x)[+b]?|unlink\s*\(|remove\s*\(|rmtree\s*\(|rename\s*\(|replace\s*\(|copy(?:file|tree)?\s*\(|move\s*\(|git\s+(?:apply|checkout|reset)|patch\s+-p|sed\s+-i)/i
const CORE_INTERNAL_IMPORT_RE = /^\s*(?:from|import)\s+(?:hermes_cli|gateway|tui_gateway|agent|tools)(?:\.|\s|$)/m
const CORE_RUNTIME_PATCH_RE = /(?:sys\.modules\s*\[[^\]]*(?:hermes_cli|gateway|tui_gateway|agent|tools)[^\]]*\]\s*=|setattr\s*\([^\n]{0,120}(?:hermes_cli|gateway|tui_gateway|agent|tools)|mock\.patch(?:\.object)?\s*\([^\n]{0,120}(?:hermes_cli|gateway|tui_gateway|agent|tools))/i
const CORE_ENV_MUTATION_RE = /(?:sys\.executable[^\n]{0,160}-m\s+pip\s+install|(?:pip|uv\s+pip)\s+install[^\n]{0,180}(?:site-packages|hermes-agent|hermes_cli))/i

function scanCoreTamperSource(source, file = 'plugin.js') {
  const text = String(source || '')
  const findings = []
  const push = (id, severity, label, index = 0) => findings.push({
    id,
    severity,
    label,
    file,
    line: lineForOffset(text, Math.max(0, index)),
    source: 'core-protection'
  })

  const pathMatch = text.match(CORE_PATH_RE)
  const mutationMatch = text.match(CORE_MUTATION_RE)

  if (pathMatch && mutationMatch) {
    push(
      'CORE001',
      'critical',
      'direct mutation of Hermes install/core path',
      Math.min(pathMatch.index ?? 0, mutationMatch.index ?? 0)
    )
  }

  const runtimePatch = text.match(CORE_RUNTIME_PATCH_RE)
  if (runtimePatch) {
    push('CORE002', 'critical', 'runtime patch of Hermes host module', runtimePatch.index ?? 0)
  }

  const envMutation = text.match(CORE_ENV_MUTATION_RE)
  if (envMutation) {
    push('CORE003', 'critical', 'package-manager mutation of Hermes host runtime', envMutation.index ?? 0)
  }

  const internalImport = text.match(CORE_INTERNAL_IMPORT_RE)
  if (internalImport && (mutationMatch || /(?:monkeypatch|patch\.object|mock\.patch)/i.test(text))) {
    push('CORE101', 'high', 'internal Hermes import combined with mutation/patch behavior', internalImport.index ?? 0)
  } else if (internalImport) {
    push('CORE102', 'medium', 'direct dependency on Hermes internal module', internalImport.index ?? 0)
  }

  if (pathMatch && !mutationMatch) {
    push('CORE103', 'medium', 'references Hermes install/core path', pathMatch.index ?? 0)
  }

  return findings
}

function hasCoreProtectionBlocker(findings, mode = coreProtectionMode.get()) {
  if (mode !== 'strict') return false
  return (findings || []).some(finding => finding.severity === 'critical' || finding.severity === 'high')
}

function coreApprovalKey(identity, sha) {
  const id = String(identity || '').trim()
  const pin = String(sha || '').trim().toLowerCase()
  if (!id || !/^[0-9a-f]{40}$/.test(pin)) return null
  return id + '@' + pin
}

function isCoreVersionApproved(identity, sha) {
  const key = coreApprovalKey(identity, sha)
  return Boolean(key && coreVersionApprovals.get()?.[key])
}

function coreApprovalEffective(mode, storedApproval) {
  return mode === 'smart' && Boolean(storedApproval)
}

function setCoreVersionApproval(identity, sha, allowed = true) {
  const key = coreApprovalKey(identity, sha)
  if (!key) return false

  const next = { ...(coreVersionApprovals.get() || {}) }
  if (allowed) {
    next[key] = {
      identity: String(identity),
      sha: String(sha).toLowerCase(),
      approvedAt: new Date().toISOString()
    }
  } else {
    delete next[key]
  }

  coreVersionApprovals.set(next)
  pluginStorage?.set('coreProtection.approvals', next)
  return true
}

function runPreflight(files, context = {}) {
  const security = securityMode.get() === 'off'
    ? []
    : (files || []).flatMap(file => scanSource(file.text, file.path || file.name || 'plugin.js'))
  const core = (files || []).flatMap(file => scanCoreTamperSource(file.text, file.path || file.name || 'plugin.js'))

  const coreMode = coreProtectionMode.get()
  const coreTamper = core.some(finding => finding.severity === 'critical' || finding.severity === 'high')
  const storedApproval = isCoreVersionApproved(context.identity, context.sha)
  const smartApproval = coreApprovalEffective(coreMode, storedApproval)

  return {
    findings: [...security, ...core],
    securityBlocked: hasBlockingFinding(security),
    coreBlocked: hasCoreProtectionBlocker(core, coreMode),
    reviewRequired: !smartApproval && coreMode === 'smart' && coreTamper,
    coreApproved: smartApproval,
    storedCoreApproval: storedApproval,
    approvalKey: coreApprovalKey(context.identity, context.sha),
    blocked: hasBlockingFinding(security) || hasCoreProtectionBlocker(core, coreMode)
  }
}

function preflightDecision(preflight, identity, sha) {
  if (preflight?.securityBlocked) {
    return {
      allowed: false,
      stage: 'security-blocked',
      canApproveCore: false,
      approvalIdentity: null,
      approvalSha: null
    }
  }

  if (preflight?.coreBlocked || preflight?.reviewRequired) {
    const approvalKey = preflight?.reviewRequired ? coreApprovalKey(identity, sha) : null
    return {
      allowed: false,
      stage: preflight.coreBlocked ? 'core-blocked' : 'core-review-required',
      canApproveCore: Boolean(approvalKey),
      approvalIdentity: approvalKey ? String(identity) : null,
      approvalSha: approvalKey ? String(sha).toLowerCase() : null
    }
  }

  return {
    allowed: true,
    stage: 'allowed',
    canApproveCore: false,
    approvalIdentity: null,
    approvalSha: null
  }
}

function applyCoreApproval(identity, sha, resume = 'repair') {
  if (!setCoreVersionApproval(identity, sha, true)) return

  if (resume === 'update') {
    void updateAllPlugins()
  } else if (resume === 'install') {
    void installFromInput()
  } else {
    void reconcile('core-approval')
  }
}

function setSecurityMode(mode) {
  const next = SECURITY_MODES.has(mode) ? mode : 'smart'
  securityMode.set(next)
  pluginStorage?.set('security.mode', next)
  void reconcile('security-mode')
}

function setCoreProtectionMode(mode) {
  const next = CORE_PROTECTION_MODES.has(mode) ? mode : 'smart'
  coreProtectionMode.set(next)
  pluginStorage?.set('coreProtection.mode', next)
  void reconcile('core-protection-mode')
}

function setBooleanPreference(key, target, value) {
  const next = Boolean(value)
  target.set(next)
  pluginStorage?.set(key, next)
  void reconcile('preference-change')
}

function riskCounts(findings) {
  const counts = { critical: 0, high: 0, medium: 0 }
  for (const finding of findings || []) {
    if (counts[finding.severity] !== undefined) counts[finding.severity] += 1
  }
  return counts
}

async function readPluginText(desktop, path) {
  const reader = desktop.readPluginSource || desktop.readFileText
  if (!reader) throw new Error('Desktop file reader unavailable')
  const result = await reader(path)
  if (result?.truncated) throw new Error('Plugin source was truncated')
  return String(result?.text || '')
}

async function localPluginInventory(desktop, root) {
  const result = await desktop.readDir(root)
  const byId = new Map()
  const byFolder = new Map()
  for (const entry of result?.entries || []) {
    if (!entry?.isDirectory) continue
    byFolder.set(entry.name, entry.path)

    try {
      const file = joinPath(entry.path, 'plugin.js')
      const source = await readPluginText(desktop, file)
      const id = extractPluginId(source)
      if (id) byId.set(id, { folder: entry.name, path: entry.path, source })
    } catch {
      // A non-plugin folder or a file mid-write is ignored until the next pass.
    }
  }

  return { byId, byFolder }
}

async function readCatalog(desktop, desktopRoot) {
  const home = parentPath(desktopRoot)
  const path = joinPath(home, 'cache', 'plugin-catalog.json')
  const result = await desktop.readFileText(path)
  if (result?.truncated) throw new Error('Plugin catalog cache is truncated')
  const parsed = JSON.parse(String(result?.text || '{}'))
  return Array.isArray(parsed?.entries) ? parsed.entries : []
}

function githubRepoSlug(repoUrl) {
  try {
    const url = new URL(repoUrl)
    if (url.hostname !== 'github.com') return null
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  } catch {
    return null
  }
}
function parseGitHubInstallIdentifier(value) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('Enter a GitHub repository URL or owner/repo.')

  let owner = ''
  let repo = ''
  let subdir = ''
  let ref = ''

  if (/^https:\/\/github\.com\//i.test(raw)) {
    const url = new URL(raw)
    const hashSubdir = String(url.hash || '').replace(/^#/, '').replace(/^\/+|\/+$/g, '')
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)

    if (parts.length < 2) throw new Error('GitHub URL must include owner and repository.')

    owner = parts[0]
    repo = parts[1].replace(/\.git$/i, '')

    if (parts[2] === 'tree' && parts[3]) {
      ref = decodeURIComponent(parts[3])
      subdir = parts.slice(4).join('/')
    } else if (parts.length > 2) {
      subdir = parts.slice(2).join('/')
    }

    if (hashSubdir) subdir = hashSubdir
  } else {
    const hashIndex = raw.indexOf('#')
    const beforeHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw
    const hashSubdir = hashIndex >= 0 ? raw.slice(hashIndex + 1) : ''
    const parts = beforeHash.split('/').filter(Boolean)

    if (parts.length < 2) throw new Error("Use 'owner/repo' or a GitHub URL.")

    owner = parts[0]
    repo = parts[1].replace(/\.git$/i, '')
    subdir = hashSubdir || parts.slice(2).join('/')
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('Unsupported GitHub owner/repository name.')
  }

  subdir = String(subdir || '').replace(/^\/+|\/+$/g, '')
  if (subdir.includes('..') || subdir.includes('\\')) {
    throw new Error('Unsafe repository subdirectory.')
  }

  const slug = owner + '/' + repo
  const repoUrl = 'https://github.com/' + slug
  const identifier = subdir ? repoUrl + '#' + subdir : repoUrl
  const identity = subdir ? slug + '#' + subdir : slug

  return { owner, repo, slug, repoUrl, subdir, ref, identifier, identity }
}

async function resolveGitHubInstallSha(target) {
  let ref = String(target?.ref || '').trim()

  if (!ref) {
    const repoResponse = await fetch('https://api.github.com/repos/' + target.slug, {
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (!repoResponse.ok) {
      throw new Error('GitHub repository lookup failed: HTTP ' + repoResponse.status)
    }
    const repo = await repoResponse.json()
    ref = String(repo?.default_branch || '').trim()
    if (!ref) throw new Error('GitHub default branch could not be resolved.')
  }

  const response = await fetch(
    'https://api.github.com/repos/' + target.slug + '/commits/' + encodeURIComponent(ref),
    { headers: { Accept: 'application/vnd.github+json' } }
  )
  if (!response.ok) throw new Error('GitHub commit lookup failed: HTTP ' + response.status)

  const commit = await response.json()
  const sha = String(commit?.sha || '').trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('GitHub did not return a full commit SHA.')
  return sha
}

async function fetchGitHubDirectoryFiles(slug, directory, sha) {
  const cleanDir = String(directory || '').replace(/^\/+|\/+$/g, '')
  const suffix = cleanDir ? '/' + cleanDir.split('/').map(encodeURIComponent).join('/') : ''
  const api = 'https://api.github.com/repos/' + slug + '/contents' + suffix + '?ref=' + sha
  const response = await fetch(api, { headers: { Accept: 'application/vnd.github+json' } })
  if (!response.ok) return null

  const listing = await response.json()
  if (!Array.isArray(listing)) return null

  const files = []
  for (const item of listing) {
    if (item?.type !== 'file' || !item?.name || !item?.download_url) continue
    if (Number(item.size || 0) > 1024 * 1024) {
      throw new Error('GitHub file too large for checked Desktop install: ' + item.name)
    }

    const fileResponse = await fetch(item.download_url)
    if (!fileResponse.ok) {
      throw new Error('GitHub file fetch failed: ' + item.name + ' HTTP ' + fileResponse.status)
    }
    files.push({ name: item.name, text: await fileResponse.text() })
  }

  return files
}

async function fetchPinnedDesktopFilesForInstall(target, sha) {
  const packageRoot = String(target?.subdir || '').replace(/^\/+|\/+$/g, '')
  const desktopDir = packageRoot ? packageRoot + '/desktop' : 'desktop'
  let files = await fetchGitHubDirectoryFiles(target.slug, desktopDir, sha)

  if (!files?.some(file => file.name === 'plugin.js')) {
    files = await fetchGitHubDirectoryFiles(target.slug, packageRoot, sha)
  }

  if (!files?.some(file => file.name === 'plugin.js')) {
    throw new Error('Pinned GitHub commit has no Desktop plugin.js at the detected package root.')
  }

  return files
}

async function fetchPinnedDesktopFiles(entry, sha) {
  const slug = githubRepoSlug(entry?.repo)
  if (!slug || !/^[0-9a-f]{40}$/i.test(String(sha || ''))) {
    throw new Error('Pinned GitHub source unavailable')
  }

  const subdir = entry?.subdir ? `${String(entry.subdir).replace(/^\/+|\/+$/g, '')}/desktop` : 'desktop'
  const api = `https://api.github.com/repos/${slug}/contents/${subdir}?ref=${sha}`
  const listingResponse = await fetch(api, { headers: { Accept: 'application/vnd.github+json' } })
  if (!listingResponse.ok) throw new Error(`Pinned Desktop directory fetch failed: HTTP ${listingResponse.status}`)

  const listing = await listingResponse.json()
  if (!Array.isArray(listing)) throw new Error('Pinned Desktop directory is not a directory')

  const files = []
  for (const item of listing) {
    if (item?.type !== 'file' || !item?.name || !item?.download_url) {
      throw new Error('Pinned Desktop package contains unsupported non-file content')
    }
    if (Number(item.size || 0) > 1024 * 1024) {
      throw new Error(`Pinned Desktop file too large: ${item.name}`)
    }

    const response = await fetch(item.download_url)
    if (!response.ok) throw new Error(`Pinned file fetch failed: ${item.name} HTTP ${response.status}`)
    files.push({ name: item.name, text: await response.text() })
  }

  if (!files.some(file => file.name === 'plugin.js')) throw new Error('Pinned Desktop package has no plugin.js')
  return files
}
function shouldScanRuntimePath(relativePath) {
  const rel = String(relativePath || '').replace(/^\/+/, '')
  if (!rel || /(^|\/)(?:tests?|docs?|examples?|fixtures?|\.github|node_modules|dist|build)\//i.test(rel)) return false
  return /(^|\/)(?:plugin\.ya?ml|requirements[^/]*\.txt|pyproject\.toml|package\.json|mcp\.json|[^/]+\.(?:py|js|mjs|cjs|ts|tsx|sh|ps1))$/i.test(rel)
}

async function fetchPinnedRuntimeFiles(entry, sha) {
  const slug = githubRepoSlug(entry?.repo)
  if (!slug || !/^[0-9a-f]{40}$/i.test(String(sha || ''))) {
    throw new Error('Pinned GitHub source unavailable')
  }

  const commitResponse = await fetch('https://api.github.com/repos/' + slug + '/git/commits/' + sha, {
    headers: { Accept: 'application/vnd.github+json' }
  })
  if (!commitResponse.ok) throw new Error('Pinned commit metadata fetch failed: HTTP ' + commitResponse.status)
  const commit = await commitResponse.json()
  const treeSha = commit?.tree?.sha
  if (!treeSha) throw new Error('Pinned Git tree unavailable')

  const treeResponse = await fetch('https://api.github.com/repos/' + slug + '/git/trees/' + treeSha + '?recursive=1', {
    headers: { Accept: 'application/vnd.github+json' }
  })
  if (!treeResponse.ok) throw new Error('Pinned tree fetch failed: HTTP ' + treeResponse.status)
  const tree = await treeResponse.json()

  const prefix = entry?.subdir ? String(entry.subdir).replace(/^\/+|\/+$/g, '') + '/' : ''
  const candidates = []
  let totalBytes = 0

  for (const item of tree?.tree || []) {
    if (item?.type !== 'blob' || !item?.path) continue
    if (prefix && !item.path.startsWith(prefix)) continue

    const relative = prefix ? item.path.slice(prefix.length) : item.path
    if (!shouldScanRuntimePath(relative)) continue

    const size = Number(item.size || 0)
    if (size > 512 * 1024) continue
    if (candidates.length >= 80 || totalBytes + size > 2 * 1024 * 1024) break

    candidates.push({ path: item.path, relative })
    totalBytes += size
  }

  const files = []
  for (const item of candidates) {
    const encoded = item.path.split('/').map(encodeURIComponent).join('/')
    const url = 'https://raw.githubusercontent.com/' + slug + '/' + sha + '/' + encoded
    const response = await fetch(url)
    if (!response.ok) throw new Error('Pinned source fetch failed: ' + item.relative)
    files.push({ path: item.relative, text: await response.text() })
  }

  return files
}

async function probeUnifiedPackage(desktop, entry) {
  if (!desktop.probePluginRepo) return null
  if (probeCache.has(entry.name)) return probeCache.get(entry.name)

  const identifier = entry.subdir ? entry.repo + '#' + entry.subdir : entry.repo
  try {
    const result = await desktop.probePluginRepo({ identifier })
    probeCache.set(entry.name, result)
    return result
  } catch (error) {
    const result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    probeCache.set(entry.name, result)
    return result
  }
}

function catalogEntryForLocal(local, catalog) {
  const matches = catalog.filter(entry => entry?.name === local.id || entry?.name === local.folder)
  return matches.length === 1 ? matches[0] : null
}

async function pinInstalledTree(desktop, targetPath, files) {
  const keep = new Set(files.map(file => file.name))
  const local = await desktop.readDir(targetPath)

  for (const entry of local?.entries || []) {
    if (!keep.has(entry.name) && desktop.trashPath) {
      await desktop.trashPath(entry.path)
    }
  }

  for (const file of files) {
    if (!desktop.writeTextFile) throw new Error('Desktop writeTextFile unavailable')
    await desktop.writeTextFile(joinPath(targetPath, file.name), file.text)
  }
}

async function repairCatalogFolder(desktop, root) {
  if (!desktop.renamePath) return false
  const inventory = await localPluginInventory(desktop, root)
  const catalogPath = inventory.byFolder.get('catalog')
  if (!catalogPath) return false

  let source
  try {
    source = await readPluginText(desktop, joinPath(catalogPath, 'plugin.js'))
  } catch {
    return false
  }

  const pluginId = extractPluginId(source)
  if (!pluginId || pluginId === 'catalog') return false

  const existing = inventory.byId.get(pluginId)
  if (existing && existing.path !== catalogPath) {
    if (desktop.trashPath) await desktop.trashPath(catalogPath)
    log('removed duplicate catalog folder for', pluginId)
    return true
  }
  if (inventory.byFolder.has(pluginId)) {
    warn('refusing catalog rename because target folder already exists:', pluginId)
    return false
  }

  await desktop.renamePath(catalogPath, pluginId)
  log('repaired catalog folder ->', pluginId)
  return true
}

async function ensureRemoteDesktopHalves(desktop, root, report = null) {
  const response = await host.request('plugins.manage', { action: 'list' })
  const rows = Array.isArray(response?.plugins) ? response.plugins : []
  const catalog = await readCatalog(desktop, root)
  let inventory = await localPluginInventory(desktop, root)
  const installed = []

  if (report) {
    report.serverUnified = rows
      .filter(row => row?.has_desktop_half)
      .map(row => ({
        name: row.name,
        catalog_name: row.catalog_name || null,
        installed_sha: row.installed_sha || row.pinned_sha || null,
        source: row.source,
        status: row.status
      }))
    report.localIds = [...inventory.byId.keys()].sort()
    report.catalogCount = catalog.length
  }

  report && (report.attempts = [])

  for (const row of rows) {
    if (!row?.has_desktop_half || !row?.catalog_name) continue

    const attempt = { name: row.name, catalog: row.catalog_name, stage: 'candidate', error: null }
    report?.attempts?.push(attempt)

    if (inventory.byId.has(row.name)) {
      attempt.stage = 'already-local-name'
      continue
    }

    const entry = catalog.find(item => item?.name === row.catalog_name)
    if (!entry?.repo) {
      attempt.stage = 'catalog-missing'
      continue
    }

    const sha = String(row.installed_sha || entry.sha || '')
    if (!/^[0-9a-f]{40}$/i.test(sha)) continue
    attempt.sha = sha

    let pinnedFiles
    try {
      attempt.stage = 'fetch-pinned'
      pinnedFiles = await fetchPinnedDesktopFiles(entry, sha)
    } catch (error) {
      attempt.stage = 'fetch-failed'
      attempt.error = error instanceof Error ? error.message : String(error)
      warn(row.catalog_name, attempt.error)
      continue
    }

    const pluginSource = pinnedFiles.find(file => file.name === 'plugin.js')?.text || ''
    const expectedId = extractPluginId(pluginSource) || row.name || entry.name
    attempt.expectedId = expectedId
    const preflight = runPreflight(
      pinnedFiles.map(file => ({ ...file, path: 'desktop/' + file.name })),
      { identity: row.catalog_name, sha }
    )
    attempt.findings = preflight.findings
    if (report?.findings) report.findings.push(...attempt.findings.map(finding => ({ ...finding, plugin: row.catalog_name })))
    const decision = preflightDecision(preflight, row.catalog_name, sha)
    if (!decision.allowed) {
      Object.assign(attempt, decision)
      continue
    }
    if (inventory.byId.has(expectedId)) {
      attempt.stage = 'already-local'
      continue
    }
    const identifier = entry.subdir ? `${entry.repo}#${entry.subdir}` : entry.repo
    const installer = desktop.installDesktopPlugin
    if (!installer) throw new Error('Desktop installDesktopPlugin unavailable')

    attempt.stage = 'installing'
    const result = await installer({ identifier, force: false })
    if (!result?.ok || !result.path) {
      attempt.stage = 'install-failed'
      attempt.error = result?.error || 'unknown error'
      warn('desktop install failed for', row.catalog_name, attempt.error)
      continue
    }

    attempt.installerPath = result.path
    attempt.stage = 'pinning'
    await pinInstalledTree(desktop, result.path, pinnedFiles)

    let finalPath = result.path
    if (baseName(result.path) !== expectedId && desktop.renamePath) {
      inventory = await localPluginInventory(desktop, root)

      const existingById = inventory.byId.get(expectedId)
      const existingFolderPath = inventory.byFolder.get(expectedId)

      if (
        (existingById && existingById.path !== result.path) ||
        (existingFolderPath && existingFolderPath !== result.path)
      ) {
        attempt.stage = 'destination-conflict'
        attempt.error = 'Existing Desktop destination kept'
        if (desktop.trashPath) await desktop.trashPath(result.path)
        continue
      }

      const renamed = await desktop.renamePath(result.path, expectedId)
      finalPath = renamed?.path || joinPath(root, expectedId)
    }

    installed.push({ id: expectedId, catalog: row.catalog_name, sha, path: finalPath })
    attempt.stage = 'installed'
    attempt.finalPath = finalPath
    inventory = await localPluginInventory(desktop, root)
    log('installed missing remote Desktop half', expectedId, sha.slice(0, 8))
  }

  return installed
}
function readPackageSnapshot() {
  const value = pluginStorage?.get('packages.snapshot', {})
  return value && typeof value === 'object' ? value : {}
}

function writePackageSnapshot(halves) {
  if (!pluginStorage) return
  const snapshot = {}
  for (const item of halves || []) {
    snapshot[item.catalog] = {
      agent: Boolean(item.agent),
      desktop: Boolean(item.desktop),
      agentExpected: item.agentExpected !== false,
      desktopExpected: item.desktopExpected !== false
    }
  }
  pluginStorage.set('packages.snapshot', snapshot)
}

function readUninstallTombstones() {
  const value = pluginStorage?.get('uninstall.tombstones', {})
  const now = Date.now()
  const next = {}

  if (value && typeof value === 'object') {
    for (const [name, at] of Object.entries(value)) {
      const ts = Number(at)
      if (Number.isFinite(ts) && now - ts < UNINSTALL_TOMBSTONE_TTL_MS) {
        next[name] = ts
      }
    }
  }

  return next
}

function writeUninstallTombstones(value) {
  pluginStorage?.set('uninstall.tombstones', value)
}

function isExpectedMissingHalf(item) {
  return Boolean(
    (item?.agentExpected === true && !item?.agent) ||
    (item?.desktopExpected === true && !item?.desktop)
  )
}

function shouldTreatAsIntentionalAgentRemoval(previous, item, reason = 'timer') {
  if (reason === 'manual') return false
  return Boolean(
    item?.agentExpected === true &&
    item?.desktopExpected === true &&
    !item?.agent &&
    item?.desktop &&
    previous?.agent === true &&
    previous?.desktop === true
  )
}

async function syncIntentionalAgentRemovals(desktop, halves, inventory, report, reason) {
  if (!respectUninstallIntent.get()) {
    writeUninstallTombstones({})
    return new Set()
  }

  const previous = readPackageSnapshot()
  const tombstones = reason === 'manual' ? {} : readUninstallTombstones()
  const now = Date.now()

  for (const item of halves || []) {
    if (item.agent) {
      if (tombstones[item.catalog]) delete tombstones[item.catalog]
      continue
    }

    if (shouldTreatAsIntentionalAgentRemoval(previous[item.catalog], item, reason)) {
      tombstones[item.catalog] = now
    }
  }

  for (const item of halves || []) {
    if (!tombstones[item.catalog] || item.agent || !item.desktop) continue

    const local = item.desktopId ? inventory.byId.get(item.desktopId) : null
    const path = local?.path || item.desktopPath || null
    const attempt = {
      name: item.catalog,
      catalog: item.catalog,
      stage: 'uninstall-sync',
      error: null
    }
    report?.attempts?.push(attempt)

    if (!path || !desktop.trashPath) {
      attempt.stage = 'uninstall-sync-pending'
      attempt.error = 'Local Desktop half could not be removed automatically'
      continue
    }

    try {
      await desktop.trashPath(path)
      attempt.stage = 'uninstall-synced'
    } catch (error) {
      attempt.stage = 'uninstall-sync-pending'
      attempt.error = error instanceof Error ? error.message : String(error)
    }
  }

  writeUninstallTombstones(tombstones)
  return new Set(Object.keys(tombstones))
}

async function ensureAgentHalves(desktop, root, report = null, skipCatalogs = new Set()) {
  const response = await host.request('plugins.manage', { action: 'list' })
  const rows = Array.isArray(response?.plugins) ? response.plugins : []
  const catalog = await readCatalog(desktop, root)
  const inventory = await localPluginInventory(desktop, root)
  const installedCatalogs = new Set()

  for (const row of rows) {
    if (row?.catalog_name) installedCatalogs.add(row.catalog_name)
    if (row?.name) installedCatalogs.add(row.name)
  }

  for (const local of inventory.byId.values()) {
    if (local.id === ID) continue

    const entry = catalogEntryForLocal(local, catalog)
    if (!entry?.repo || installedCatalogs.has(entry.name)) continue
    if (skipCatalogs.has(entry.name)) {
      report?.attempts?.push({ name: local.id, catalog: entry.name, stage: 'uninstall-tombstone', error: null })
      continue
    }

    const probe = await probeUnifiedPackage(desktop, entry)
    if (!probe?.ok || !probe.agent || !probe.desktop) continue

    const sha = String(entry.sha || '')
    if (!/^[0-9a-f]{40}$/i.test(sha)) continue

    const attempt = { name: local.id, catalog: entry.name, stage: 'agent-candidate', error: null, sha }
    report?.attempts?.push(attempt)

    let sourceFiles
    try {
      sourceFiles = await fetchPinnedRuntimeFiles(entry, sha)
    } catch (error) {
      attempt.stage = 'agent-review-failed'
      attempt.error = error instanceof Error ? error.message : String(error)
      continue
    }

    const preflight = runPreflight(sourceFiles, { identity: entry.name, sha })
    attempt.findings = preflight.findings
    if (report?.findings) {
      report.findings.push(...attempt.findings.map(finding => ({ ...finding, plugin: entry.name })))
    }

    const decision = preflightDecision(preflight, entry.name, sha)
    if (!decision.allowed) {
      Object.assign(attempt, decision)
      continue
    }

    try {
      const result = await host.request('plugins.manage', {
        action: 'install',
        catalog_name: entry.name,
        enable: autoEnableRepairedAgents.get()
      })

      if (!result?.ok) {
        if (result?.scan_blocked) {
          attempt.stage = 'hermes-core-blocked'
          attempt.error = result?.error || 'Hermes Core security scan blocked install'
          for (const finding of result?.scan_findings || []) {
            report?.findings?.push({
              id: 'HERMES:' + String(finding.pattern_id || 'scan'),
              severity:
                finding.severity === 'critical'
                  ? 'critical'
                  : finding.severity === 'high'
                    ? 'high'
                    : 'medium',
              label: String(finding.description || finding.category || 'Hermes Core security finding'),
              file: String(finding.file || 'server package'),
              line: Number(finding.line || 0),
              plugin: entry.name,
              source: 'hermes-core'
            })
          }
        } else {
          attempt.stage = 'agent-install-failed'
          attempt.error = result?.error || 'Gateway rejected install'
        }
        continue
      }

      installedCatalogs.add(entry.name)
      attempt.stage = 'agent-installed'
      attempt.sha = sha
    } catch (error) {
      attempt.stage = 'agent-install-failed'
      attempt.error = error instanceof Error ? error.message : String(error)
    }
  }
}

async function buildHalfRows(desktop, rows, inventory, catalog) {
  const result = []
  const seen = new Set()

  for (const row of rows) {
    if (!row?.has_desktop_half || !row?.catalog_name) continue

    const local = inventory.byId.get(row.name) || inventory.byId.get(row.catalog_name) || null

    result.push({
      catalog: row.catalog_name,
      agentExpected: true,
      desktopExpected: true,
      agent: true,
      agentName: row.name || row.catalog_name,
      agentKey: row.key || null,
      agentStatus: row.status || 'installed',
      updateAvailable: Boolean(row.update_available),
      desktop: Boolean(local),
      desktopId: local?.id || null,
      desktopPath: local?.path || null,
      sha: row.installed_sha || row.pinned_sha || null
    })
    seen.add(row.catalog_name)
  }

  for (const local of inventory.byId.values()) {
    if (local.id === ID) continue
    const entry = catalogEntryForLocal(local, catalog)
    if (!entry || seen.has(entry.name)) continue

    const probe = await probeUnifiedPackage(desktop, entry)
    const agentExpected = probe?.ok ? Boolean(probe.agent) : null
    const desktopExpected = probe?.ok ? Boolean(probe.desktop) : true

    result.push({
      catalog: entry.name,
      agentExpected,
      desktopExpected,
      agent: false,
      agentStatus: agentExpected === false ? 'desktop only' : agentExpected === true ? 'missing' : 'unknown',
      desktop: true,
      desktopId: local.id,
      desktopPath: local.path,
      sha: entry.sha || null
    })
  }

  return result.sort((a, b) => a.catalog.localeCompare(b.catalog))
}

async function reconcile(reason = 'timer') {
  if (running) return lastRun
  running = true

  const report = {
    version: VERSION,
    at: new Date().toISOString(),
    reason,
    error: null,
    installed: [],
    findings: [],
    attempts: [],
    halves: []
  }

  let desktop = null
  let root = null
  menderState.set({ ...menderState.get(), running: true, reason, error: null })

  try {
    const compatibility = await checkCompatibility(reason === 'startup' || reason === 'connection-applied')
    report.compatibility = compatibility

    if (compatibility.status === 'unsupported') {
      report.error = compatibility.summary
      lastRun = report
      menderState.set({
        ...menderState.get(),
        running: false,
        at: report.at,
        reason,
        error: compatibility.summary
      })
      return report
    }

    desktop = window.hermesDesktop
    if (!desktop?.desktopPluginsRoot || !desktop?.readDir) {
      throw new Error('Required Hermes Desktop bridge is unavailable')
    }

    root = await desktop.desktopPluginsRoot()
    await repairCatalogFolder(desktop, root)

    const catalog = await readCatalog(desktop, root)
    const initial = await host.request('plugins.manage', { action: 'list' })
    const initialRows = Array.isArray(initial?.plugins) ? initial.plugins : []
    let inventory = await localPluginInventory(desktop, root)
    const initialHalves = await buildHalfRows(desktop, initialRows, inventory, catalog)
    const uninstallTombstones = await syncIntentionalAgentRemovals(
      desktop,
      initialHalves,
      inventory,
      report,
      reason
    )

    report.installed = await ensureRemoteDesktopHalves(desktop, root, report)
    await ensureAgentHalves(desktop, root, report, uninstallTombstones)

    const latest = await host.request('plugins.manage', { action: 'list' })
    const rows = Array.isArray(latest?.plugins) ? latest.plugins : []
    inventory = await localPluginInventory(desktop, root)

    report.halves = await buildHalfRows(desktop, rows, inventory, catalog)
    writePackageSnapshot(report.halves)

    if (securityMode.get() !== 'off' || coreProtectionMode.get() !== 'off') {
      for (const local of inventory.byId.values()) {
        if (local.id === ID) continue
        const preflight = runPreflight([{ name: 'plugin.js', path: 'plugin.js', text: local.source }])
        report.findings.push(...preflight.findings.map(finding => ({ ...finding, plugin: local.id })))
      }
    }

    const unique = new Map()
    for (const finding of report.findings) {
      const key = [finding.plugin, finding.file, finding.line, finding.id].join('|')
      unique.set(key, finding)
    }
    report.findings = [...unique.values()].slice(0, 160)

    const missing = report.halves.filter(isExpectedMissingHalf).length
    const actions = report.attempts
      .filter(item => !['already-local', 'already-local-name', 'candidate'].includes(item.stage))
      .map(item => ({
        plugin: item.catalog || item.name,
        type: item.stage,
        detail: item.error || (item.sha ? 'pin ' + String(item.sha).slice(0, 8) : ''),
        canApproveCore: Boolean(item.canApproveCore),
        approvalIdentity: item.approvalIdentity || null,
        approvalSha: item.approvalSha || null,
        reviewFindings: (item.findings || [])
          .filter(finding => finding.source === 'core-protection')
          .slice(0, 8),
        resume: 'repair'
      }))

    lastRun = report
    menderState.set({
      version: VERSION,
      running: false,
      at: report.at,
      reason,
      error: null,
      missing,
      halves: report.halves,
      findings: report.findings,
      actions: actions.slice(-40)
    })

    return report
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    lastRun = report
    warn('reconcile failed:', report.error)
    menderState.set({
      ...menderState.get(),
      running: false,
      at: report.at,
      reason,
      error: report.error
    })
    return report
  } finally {
    try {
      if (desktop?.writeTextFile && root) {
        await desktop.writeTextFile(
          joinPath(parentPath(root), 'cache', 'mender-state.json'),
          JSON.stringify(report, null, 2) + '\n'
        )
      }
    } catch {
      // Diagnostics must never affect reconciliation.
    }
    running = false
  }
}

function safeCliPluginName(name) {
  const value = String(name || '')
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : null
}

function seedUninstallTombstone(item) {
  if (!respectUninstallIntent.get() || !item?.catalog) return
  const tombstones = readUninstallTombstones()
  tombstones[item.catalog] = Date.now()
  writeUninstallTombstones(tombstones)
}

async function uninstallPlugin(item) {
  if (!item || operationBusy.get()) return

  const confirmed =
    typeof window.confirm !== 'function' ||
    window.confirm('Remove ' + item.catalog + '? Mender will remove every installed half it manages for this package.')

  if (!confirmed) return

  operationBusy.set(true)
  seedUninstallTombstone(item)

  try {
    const desktop = window.hermesDesktop

    if (item.agent) {
      let removed = false
      let removeError = null

      try {
        const result = await host.request('plugins.manage', {
          action: 'remove',
          name: item.agentName || item.catalog
        })
        removed = Boolean(result?.ok)
        if (!removed) removeError = result?.error || 'Hermes rejected plugin removal'
      } catch (error) {
        removeError = error instanceof Error ? error.message : String(error)
      }

      if (!removed && /unknown\s+plugins\s+action:\s*remove/i.test(String(removeError || ''))) {
        const cliName = safeCliPluginName(item.agentName || item.catalog)
        if (!cliName) {
          throw new Error('Remote gateway lacks plugins.manage remove and the canonical plugin name is not safe for CLI fallback.')
        }

        const legacy = await host.request('shell.exec', {
          command: 'hermes plugins remove ' + cliName
        })

        if (Number(legacy?.code ?? 1) !== 0) {
          throw new Error(String(legacy?.stderr || legacy?.stdout || 'Legacy Hermes remove failed'))
        }

        removed = true
      }

      if (!removed) throw new Error(String(removeError || 'Plugin removal failed'))
    } else if (item.agentExpected === false && item.desktop) {
      if (desktop?.removeDesktopPlugin && item.desktopId) {
        const result = await desktop.removeDesktopPlugin({ name: item.desktopId })
        if (!result?.ok) throw new Error(result?.error || 'Desktop plugin removal failed')
      } else if (desktop?.trashPath && item.desktopPath) {
        await desktop.trashPath(item.desktopPath)
      } else {
        throw new Error('Desktop removal bridge unavailable')
      }
    }

    if (item.desktop && item.desktopPath && desktop?.trashPath) {
      try {
        await desktop.trashPath(item.desktopPath)
      } catch {
        // The native unified-package reconcile may already have removed it.
      }
    }

    await reconcile('uninstall-ui')
  } catch (error) {
    menderState.set({
      ...menderState.get(),
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    operationBusy.set(false)
  }
}

async function setAgentEnabled(item, enable = true) {
  if (!item?.agentKey || operationBusy.get()) return
  operationBusy.set(true)

  try {
    const result = await host.request('plugins.manage', {
      action: 'toggle',
      key: item.agentKey,
      enable: Boolean(enable)
    })

    if (!result?.ok) {
      throw new Error(result?.error || 'Hermes rejected the plugin toggle')
    }

    await reconcile(enable ? 'enable-agent' : 'disable-agent')
  } catch (error) {
    menderState.set({
      ...menderState.get(),
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    operationBusy.set(false)
  }
}

function appendFindingsToState(findings, plugin) {
  if (!findings?.length) return
  const current = menderState.get()
  const merged = [
    ...(findings || []).map(finding => ({ ...finding, plugin })),
    ...(current.findings || [])
  ]
  const unique = new Map()
  for (const finding of merged) {
    const key = [finding.plugin, finding.file, finding.line, finding.id].join('|')
    unique.set(key, finding)
  }
  menderState.set({ ...current, findings: [...unique.values()].slice(0, 160) })
}

async function installFromInput() {
  if (operationBusy.get()) return
  const raw = String(installIdentifier.get() || '').trim()
  if (!raw) {
    installState.set({
      status: 'error',
      message: 'Enter a public GitHub repository URL or owner/repo.',
      identity: null,
      sha: null,
      probe: null,
      canApproveCore: false
    })
    return
  }

  operationBusy.set(true)
  installState.set({
    status: 'checking',
    message: 'Resolving GitHub commit and checking plugin source…',
    identity: null,
    sha: null,
    probe: null,
    canApproveCore: false,
    reviewFindings: []
  })

  try {
    const desktop = window.hermesDesktop
    if (!desktop?.desktopPluginsRoot || !desktop?.installDesktopPlugin) {
      throw new Error('Hermes Desktop plugin install bridge is unavailable.')
    }

    const target = parseGitHubInstallIdentifier(raw)
    const sha = await resolveGitHubInstallSha(target)
    const entry = { repo: target.repoUrl, subdir: target.subdir || null }

    const officialProbe = await desktop.probePluginRepo?.({ identifier: target.identifier })
    if (!officialProbe?.ok || (!officialProbe.agent && !officialProbe.desktop)) {
      throw new Error(officialProbe?.error || 'Hermes did not recognize this repository as a plugin.')
    }

    const sourceFiles = await fetchPinnedRuntimeFiles(entry, sha)
    const pinnedHasAgent = sourceFiles.some(file => /(^|\/)plugin\.ya?ml$/i.test(String(file.path || '')))

    let desktopFiles = []
    try {
      desktopFiles = await fetchPinnedDesktopFilesForInstall(target, sha)
    } catch {
      desktopFiles = []
    }
    const pinnedHasDesktop = desktopFiles.some(file => file.name === 'plugin.js')

    if (
      Boolean(officialProbe.agent) !== Boolean(pinnedHasAgent) ||
      Boolean(officialProbe.desktop) !== Boolean(pinnedHasDesktop)
    ) {
      throw new Error('Repository changed while being checked. Retry so Hermes and Mender inspect the same plugin shape.')
    }

    const hasAgent = Boolean(officialProbe.agent && pinnedHasAgent)
    const hasDesktop = Boolean(officialProbe.desktop && pinnedHasDesktop)

    const filesToCheck = [
      ...sourceFiles,
      ...desktopFiles.map(file => ({ ...file, path: 'desktop/' + file.name }))
    ]
    const preflight = runPreflight(filesToCheck, { identity: target.identity, sha })
    appendFindingsToState(preflight.findings, target.identity)

    const decision = preflightDecision(preflight, target.identity, sha)
    if (!decision.allowed) {
      installState.set({
        status: decision.stage,
        message:
          decision.stage === 'security-blocked'
            ? 'General security policy blocked this install. Core exceptions cannot override it.'
            : decision.stage === 'core-blocked'
              ? 'Core protection Strict blocked this exact version. Strict has no per-version bypass; switch to Smart or Off if you intentionally want Core-changing code.'
              : 'Core protection Smart requires approval before this exact version can be installed.',
        identity: target.identity,
        sha,
        probe: { agent: hasAgent, desktop: hasDesktop },
        canApproveCore: decision.canApproveCore,
        reviewFindings: preflight.findings
          .filter(finding => finding.source === 'core-protection')
          .slice(0, 12)
      })
      return
    }

    const outcomes = []

    if (hasAgent) {
      const result = await host.request('plugins.manage', {
        action: 'install',
        identifier: target.identifier,
        ref: sha,
        force: false,
        enable: installEnableAfter.get()
      })

      if (!result?.ok) {
        if (result?.scan_blocked) {
          for (const finding of result?.scan_findings || []) {
            appendFindingsToState([
              {
                id: 'HERMES:' + String(finding.pattern_id || 'scan'),
                severity:
                  finding.severity === 'critical'
                    ? 'critical'
                    : finding.severity === 'high'
                      ? 'high'
                      : 'medium',
                label: String(finding.description || finding.category || 'Hermes Core security finding'),
                file: String(finding.file || 'server package'),
                line: Number(finding.line || 0),
                source: 'hermes-core'
              }
            ], target.identity)
          }
        }
        throw new Error(result?.error || 'Hermes rejected the Agent plugin install.')
      }

      outcomes.push('Agent installed' + (installEnableAfter.get() ? ' + enabled' : ' (disabled)'))
    }

    if (hasDesktop) {
      const result = await desktop.installDesktopPlugin({
        identifier: target.identifier,
        force: false
      })

      if (!result?.ok || !result.path) {
        throw new Error(result?.error || 'Hermes rejected the Desktop plugin install.')
      }

      await pinInstalledTree(desktop, result.path, desktopFiles)

      const expectedId = extractPluginId(
        desktopFiles.find(file => file.name === 'plugin.js')?.text || ''
      )

      if (expectedId && baseName(result.path) !== expectedId && desktop.renamePath) {
        const root = await desktop.desktopPluginsRoot()
        const inventory = await localPluginInventory(desktop, root)
        const existing = inventory.byId.get(expectedId)
        const existingFolder = inventory.byFolder.get(expectedId)

        if (
          (!existing || existing.path === result.path) &&
          (!existingFolder || existingFolder === result.path)
        ) {
          await desktop.renamePath(result.path, expectedId)
        }
      }

      outcomes.push('Desktop installed')
    }

    await desktop.reconcileDesktopPlugins?.().catch(() => undefined)
    await reconcile('url-install')

    installState.set({
      status: 'success',
      message: outcomes.join(' · ') + ' · pinned ' + sha.slice(0, 8),
      identity: target.identity,
      sha,
      probe: { agent: hasAgent, desktop: hasDesktop },
      canApproveCore: false,
      reviewFindings: []
    })
  } catch (error) {
    installState.set({
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
      identity: null,
      sha: null,
      probe: null,
      canApproveCore: false
    })
  } finally {
    operationBusy.set(false)
  }
}

function desktopUpdateTextFile(name) {
  return /\.(?:js|mjs|cjs|json|css|html|md|txt|svg)$/i.test(String(name || ''))
}

async function updateDesktopOnlyPackages(desktop, root, catalog, actions, findings) {
  const inventory = await localPluginInventory(desktop, root)

  for (const local of inventory.byId.values()) {
    if (local.id === ID) continue

    const entry = catalogEntryForLocal(local, catalog)
    if (!entry?.repo || !/^[0-9a-f]{40}$/i.test(String(entry.sha || ''))) continue

    const probe = await probeUnifiedPackage(desktop, entry)
    if (!probe?.ok || probe.agent || !probe.desktop) continue

    let pinnedFiles
    try {
      pinnedFiles = await fetchPinnedDesktopFiles(entry, entry.sha)
    } catch (error) {
      actions.push({
        plugin: entry.name,
        type: 'desktop-update-check-failed',
        detail: error instanceof Error ? error.message : String(error)
      })
      continue
    }

    if (pinnedFiles.some(file => !desktopUpdateTextFile(file.name))) {
      actions.push({
        plugin: entry.name,
        type: 'desktop-update-review-required',
        detail: 'Package contains non-text Desktop files; automatic update skipped.'
      })
      continue
    }

    const preflight = runPreflight(
      pinnedFiles.map(file => ({ ...file, path: 'desktop/' + file.name })),
      { identity: entry.name, sha: entry.sha }
    )

    findings.push(...preflight.findings.map(finding => ({ ...finding, plugin: entry.name })))

    const decision = preflightDecision(preflight, entry.name, entry.sha)
    if (!decision.allowed) {
      actions.push({
        plugin: entry.name,
        type: decision.stage,
        detail:
          decision.stage === 'security-blocked'
            ? 'Mender security policy blocked the Desktop-only update.'
            : decision.stage === 'core-blocked'
              ? 'Core protection Strict mode blocked this Desktop-only update.'
              : 'Core protection Smart mode requires approval for this exact version.',
        canApproveCore: decision.canApproveCore,
        approvalIdentity: decision.approvalIdentity,
        approvalSha: decision.approvalSha,
        reviewFindings: preflight.findings
          .filter(finding => finding.source === 'core-protection')
          .slice(0, 8),
        resume: 'update'
      })
      continue
    }

    const expectedId = extractPluginId(pinnedFiles.find(file => file.name === 'plugin.js')?.text || '')
    if (expectedId && expectedId !== local.id) {
      actions.push({
        plugin: entry.name,
        type: 'desktop-update-review-required',
        detail: 'Pinned plugin ID differs from the installed plugin ID.'
      })
      continue
    }

    let changed = false
    const originals = []

    for (const file of pinnedFiles) {
      const path = joinPath(local.path, file.name)
      try {
        const current = await desktop.readFileText(path)
        const text = String(current?.text || '')
        originals.push({ path, existed: true, text })
        if (text !== file.text) changed = true
      } catch {
        originals.push({ path, existed: false, text: '' })
        changed = true
      }
    }

    if (!changed) continue

    try {
      const ordered = [
        ...pinnedFiles.filter(file => file.name !== 'plugin.js'),
        ...pinnedFiles.filter(file => file.name === 'plugin.js')
      ]

      for (const file of ordered) {
        await desktop.writeTextFile(joinPath(local.path, file.name), file.text)
      }

      actions.push({
        plugin: entry.name,
        type: 'desktop-update-applied',
        detail: 'Updated Desktop-only package to pin ' + String(entry.sha).slice(0, 8) + '.'
      })
    } catch (error) {
      for (const original of originals.reverse()) {
        try {
          if (original.existed) {
            await desktop.writeTextFile(original.path, original.text)
          } else if (desktop.trashPath) {
            await desktop.trashPath(original.path)
          }
        } catch {}
      }

      actions.push({
        plugin: entry.name,
        type: 'desktop-update-failed',
        detail: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

async function updateAllPlugins() {
  if (operationBusy.get()) return
  operationBusy.set(true)

  const actions = []
  const findings = []

  try {
    const desktop = window.hermesDesktop
    if (!desktop?.desktopPluginsRoot) throw new Error('Hermes Desktop plugin bridge unavailable')

    const root = await desktop.desktopPluginsRoot()
    const catalog = await readCatalog(desktop, root)
    const response = await host.request('plugins.manage', { action: 'list' })
    const rows = Array.isArray(response?.plugins) ? response.plugins : []

    for (const row of rows) {
      if (!row?.catalog_name || !row?.update_available) continue

      try {
        const entry = catalog.find(item => item?.name === row.catalog_name)
        if (entry?.repo && /^[0-9a-f]{40}$/i.test(String(entry.sha || ''))) {
          let sourceFiles
          try {
            sourceFiles = await fetchPinnedRuntimeFiles(entry, entry.sha)
          } catch (error) {
            actions.push({
              plugin: row.catalog_name,
              type: 'update-preflight-failed',
              detail: error instanceof Error ? error.message : String(error)
            })
            continue
          }

          const preflight = runPreflight(sourceFiles, { identity: row.catalog_name, sha: entry.sha })
          findings.push(...preflight.findings.map(finding => ({ ...finding, plugin: row.catalog_name })))

          const decision = preflightDecision(preflight, row.catalog_name, entry.sha)
          if (!decision.allowed) {
            actions.push({
              plugin: row.catalog_name,
              type: decision.stage,
              detail:
                decision.stage === 'security-blocked'
                  ? 'Mender security policy blocked the update before Hermes re-pin.'
                  : decision.stage === 'core-blocked'
                    ? 'Core protection Strict mode blocked this update.'
                    : 'Core protection Smart mode requires approval for this exact version.',
              canApproveCore: decision.canApproveCore,
              approvalIdentity: decision.approvalIdentity,
              approvalSha: decision.approvalSha,
              reviewFindings: preflight.findings
                .filter(finding => finding.source === 'core-protection')
                .slice(0, 8),
              resume: 'update'
            })
            continue
          }
        }

        const result = await host.request('plugins.manage', {
          action: 'update',
          name: row.name
        })

        if (result?.consent_required) {
          actions.push({
            plugin: row.catalog_name,
            type: 'update-review-required',
            detail: (result.delta_lines || []).slice(0, 4).join(' · ') || 'Update widens plugin capabilities.',
            capabilityChanges: (result.delta_lines || []).slice(0, 12)
          })
          continue
        }

        if (!result?.ok) {
          if (result?.scan_blocked) {
            actions.push({
              plugin: row.catalog_name,
              type: 'hermes-core-update-blocked',
              detail: result?.error || 'Hermes Core security scan blocked the update.'
            })
          } else {
            actions.push({
              plugin: row.catalog_name,
              type: 'update-failed',
              detail: result?.error || 'Hermes rejected the update.'
            })
          }
          continue
        }

        actions.push({
          plugin: row.catalog_name,
          type: result?.unchanged ? 'update-unchanged' : 'update-applied',
          detail: result?.unchanged ? 'Already at current catalog pin.' : 'Updated through plugins.manage.'
        })
      } catch (error) {
        actions.push({
          plugin: row.catalog_name,
          type: 'update-failed',
          detail: error instanceof Error ? error.message : String(error)
        })
      }
    }

    await updateDesktopOnlyPackages(desktop, root, catalog, actions, findings)
    await desktop.reconcileDesktopPlugins?.().catch(() => undefined)
    await reconcile('update-all')

    const current = menderState.get()
    menderState.set({
      ...current,
      findings: [...findings, ...(current.findings || [])].slice(0, 160),
      actions: [...actions, ...(current.actions || [])].slice(0, 60)
    })
  } catch (error) {
    menderState.set({
      ...menderState.get(),
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    operationBusy.set(false)
  }
}

async function startDirectoryWatch() {
  const desktop = window.hermesDesktop
  if (!desktop?.desktopPluginsRoot || !desktop?.watchDirectory || !desktop?.onPreviewFileChanged) return

  const root = await desktop.desktopPluginsRoot()
  const watch = await desktop.watchDirectory(root)
  directoryWatchId = watch?.id || null

  if (!directoryWatchId) return

  stopDirectoryEvents = desktop.onPreviewFileChanged(payload => {
    if (payload?.id === directoryWatchId) {
      void reconcile('directory-change')
    }
  })
}

function severityClass(severity) {
  if (severity === 'critical') return 'text-red-400'
  if (severity === 'high') return 'text-orange-400'
  return 'text-(--ui-text-tertiary)'
}

function BooleanChoice({ value, onChange, disabled = false }) {
  return jsxs('div', {
    className: 'flex items-center gap-1',
    children: [
      jsx(Button, {
        size: 'sm',
        variant: 'outline',
        disabled,
        onClick: () => onChange(true),
        children: (value ? '✓ ' : '') + 'On'
      }),
      jsx(Button, {
        size: 'sm',
        variant: 'outline',
        disabled,
        onClick: () => onChange(false),
        children: (!value ? '✓ ' : '') + 'Off'
      })
    ]
  })
}

function PreferenceRow({ title, description, value, onChange, disabled = false }) {
  return jsxs('div', {
    className: 'flex items-center justify-between gap-4 rounded-md border border-(--ui-stroke-secondary) px-3 py-2',
    children: [
      jsxs('div', {
        className: 'min-w-0',
        children: [
          jsx('div', { className: 'font-medium', children: title }),
          jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: description })
        ]
      }),
      jsx(BooleanChoice, { value, onChange, disabled })
    ]
  })
}

function MenderPage() {
  const state = useValue(menderState)
  const mode = useValue(securityMode)
  const coreMode = useValue(coreProtectionMode)
  const approvals = useValue(coreVersionApprovals)
  const respectUninstall = useValue(respectUninstallIntent)
  const autoEnable = useValue(autoEnableRepairedAgents)
  const busy = useValue(operationBusy)
  const installValue = useValue(installIdentifier)
  const enableAfterInstall = useValue(installEnableAfter)
  const install = useValue(installState)
  const compatibility = useValue(compatibilityState)
  const actionsAllowed = compatibility.status !== 'unsupported' && compatibility.status !== 'checking'
  const securityFindings = (state.findings || []).filter(finding => finding.source !== 'core-protection')
  const coreFindings = (state.findings || []).filter(finding => finding.source === 'core-protection')
  const securityCounts = riskCounts(securityFindings)
  const coreCounts = riskCounts(coreFindings)
  const counts = riskCounts(state.findings)
  const blockedStages = new Set([
    'review-blocked',
    'preflight-blocked',
    'agent-review-blocked',
    'agent-preflight-blocked',
    'security-blocked',
    'core-blocked',
    'hermes-core-blocked',
    'hermes-core-update-blocked',
    'desktop-update-security-blocked',
    'desktop-update-preflight-blocked'
  ])
  const blockedNow = (state.actions || []).filter(action => blockedStages.has(action.type)).length

  return jsxs('div', {
    className: 'flex h-full flex-col gap-4 overflow-auto p-5 text-sm',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-3',
        children: [
          jsxs('div', {
            children: [
              jsx('div', { className: 'text-lg font-semibold', children: 'Hermes Mender' }),
              jsx('div', {
                className: 'text-(--ui-text-tertiary)',
                children: 'Bidirectional unified-plugin repair · v' + state.version + ' · by @milanworks'
              })
            ]
          }),
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx(Button, {
                size: 'sm',
                variant: 'outline',
                disabled: state.running || busy || !actionsAllowed,
                onClick: () => void updateAllPlugins(),
                children: busy ? 'Working…' : 'Update all'
              }),
              jsx(Button, {
                size: 'sm',
                variant: 'outline',
                disabled: state.running || busy,
                onClick: () => void reconcile('manual'),
                children: state.running ? 'Checking…' : 'Repair now'
              })
            ]
          })
        ]
      }),

      state.error
        ? jsx('div', { className: 'rounded-md border border-red-500/40 p-3 text-red-400', children: state.error })
        : null,

      jsxs('section', {
        className: 'flex flex-col gap-2 rounded-md border border-(--ui-stroke-secondary) p-3',
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between gap-3',
            children: [
              jsxs('div', {
                children: [
                  jsx('div', {
                    className: 'font-medium',
                    children:
                      'Compatibility · ' +
                      (compatibility.status === 'compatible'
                        ? 'Compatible'
                        : compatibility.status === 'degraded'
                          ? 'Degraded'
                          : compatibility.status === 'unsupported'
                            ? 'Unsupported'
                            : 'Checking')
                  }),
                  jsx('div', {
                    className: 'text-xs text-(--ui-text-tertiary)',
                    children: compatibility.summary
                  })
                ]
              }),
              jsx(Button, {
                size: 'sm',
                variant: 'outline',
                disabled: busy,
                onClick: () => void checkCompatibility(true),
                children: 'Check compatibility'
              })
            ]
          }),
          (compatibility.checks || []).some(check => !check.ok)
            ? jsx('div', {
                className: 'flex flex-col gap-1',
                children: (compatibility.checks || [])
                  .filter(check => !check.ok)
                  .map(check =>
                    jsxs('div', {
                      className: 'text-xs text-(--ui-text-secondary)',
                      children: [
                        jsx('span', {
                          className: check.required ? 'font-medium text-red-400' : 'font-medium text-orange-400',
                          children: check.required ? 'Required: ' : 'Optional: '
                        }),
                        jsx('span', { children: check.label }),
                        check.detail ? jsx('span', { children: ' · ' + check.detail }) : null
                      ]
                    }, check.id)
                  )
              })
            : null,
          compatibility.checkedAt
            ? jsx('div', {
                className: 'text-xs text-(--ui-text-quaternary)',
                children: 'Checked: ' + compatibility.checkedAt
              })
            : null
        ]
      }),

      jsxs('section', {
        className: 'flex flex-col gap-2',
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between gap-3',
            children: [
              jsxs('div', {
                children: [
                  jsx('div', { className: 'font-medium', children: 'Security mode' }),
                  jsx('div', {
                    className: 'text-xs text-(--ui-text-tertiary)',
                    children:
                      mode === 'strict'
                        ? 'Strict: critical and high findings block Mender auto-repair.'
                        : mode === 'off'
                          ? 'Off: Mender preflight is disabled. Hermes Core scan-on-install remains untouched.'
                          : 'Smart: critical findings block; high and medium findings stay visible for review.'
                  })
                ]
              }),
              jsxs('div', {
                className: 'flex items-center gap-1',
                children: ['smart', 'strict', 'off'].map(option =>
                  jsx(Button, {
                    size: 'sm',
                    variant: 'outline',
                    onClick: () => setSecurityMode(option),
                    children: (mode === option ? '✓ ' : '') + option[0].toUpperCase() + option.slice(1)
                  }, option)
                )
              })
            ]
          })
        ]
      }),

      jsxs('section', {
        className: 'flex flex-col gap-2',
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between gap-3',
            children: [
              jsxs('div', {
                children: [
                  jsx('div', { className: 'font-medium', children: 'Core protection' }),
                  jsx('div', {
                    className: 'text-xs text-(--ui-text-tertiary)',
                    children:
                      coreMode === 'strict'
                        ? 'Strict: detected Core tampering is blocked. Strict has no per-version bypass; use Smart for explicit exact-version approval or Off to allow Core changes.'
                        : coreMode === 'off'
                          ? 'Off: Mender allows Core tampering. Hermes native malware scanning and capability consent remain separate and active.'
                          : 'Smart: detected Core tampering pauses and asks. Approval is stored only for that exact plugin + commit SHA.'
                  })
                ]
              }),
              jsxs('div', {
                className: 'flex items-center gap-1',
                children: ['smart', 'strict', 'off'].map(option =>
                  jsx(Button, {
                    size: 'sm',
                    variant: 'outline',
                    onClick: () => setCoreProtectionMode(option),
                    children: (coreMode === option ? '✓ ' : '') + option[0].toUpperCase() + option.slice(1)
                  }, option)
                )
              })
            ]
          }),
          Object.keys(approvals || {}).length
            ? jsxs('div', {
                className: 'flex flex-col gap-1',
                children: [
                  jsx('div', {
                    className: 'text-xs font-medium text-(--ui-text-secondary)',
                    children: 'Exact-version Core exceptions'
                  }),
                  ...Object.entries(approvals || {}).map(([key, approval]) =>
                    jsxs('div', {
                      className: 'flex items-center justify-between gap-3 rounded-md border border-(--ui-stroke-secondary) px-3 py-2',
                      children: [
                        jsxs('div', {
                          className: 'min-w-0',
                          children: [
                            jsx('div', { className: 'truncate font-medium', children: approval.identity }),
                            jsx('div', {
                              className: 'text-xs text-(--ui-text-tertiary)',
                              children: 'SHA ' + String(approval.sha || '').slice(0, 12) + ' · does not carry to updates'
                            })
                          ]
                        }),
                        jsx(Button, {
                          size: 'xs',
                          variant: 'outline',
                          onClick: () => {
                            setCoreVersionApproval(approval.identity, approval.sha, false)
                            void reconcile('core-approval-revoked')
                          },
                          children: 'Revoke'
                        })
                      ]
                    }, key)
                  )
                ]
              })
            : null
        ]
      }),

      jsxs('section', {
        className: 'flex flex-col gap-2',
        children: [
          jsx('div', { className: 'font-medium', children: 'Repair behavior' }),
          jsx(PreferenceRow, {
            title: 'Respect uninstall actions',
            description:
              'On: a previously complete unified package that loses its Agent half is treated as intentionally removed, so Mender will not immediately reinstall it. Repair now overrides this protection.',
            value: respectUninstall,
            disabled: busy,
            onChange: value => setBooleanPreference('repair.respectUninstallIntent', respectUninstallIntent, value)
          }),
          jsx(PreferenceRow, {
            title: 'Auto-enable repaired Agent halves',
            description:
              'Off by default: repaired Agent halves are installed disabled and can be enabled explicitly per plugin. On: successful repairs are enabled immediately after Hermes security checks pass.',
            value: autoEnable,
            disabled: busy,
            onChange: value => setBooleanPreference('repair.autoEnableAgents', autoEnableRepairedAgents, value)
          })
        ]
      }),

      jsxs('section', {
        className: 'flex flex-col gap-2',
        children: [
          jsx('div', { className: 'font-medium', children: 'Install from GitHub' }),
          jsx('div', {
            className: 'text-xs text-(--ui-text-tertiary)',
            children:
              'Public GitHub repositories only. Mender resolves an exact commit SHA, checks it, then uses Hermes install APIs with force disabled.'
          }),
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx('input', {
                value: installValue,
                disabled: busy,
                spellCheck: false,
                placeholder: 'https://github.com/owner/repo or owner/repo#subdir',
                className:
                  'min-w-0 flex-1 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-3 py-2 outline-none',
                onChange: event => {
                  installIdentifier.set(String(event?.target?.value || ''))
                  installState.set({
                    status: 'idle',
                    message: '',
                    identity: null,
                    sha: null,
                    probe: null,
                    canApproveCore: false
                  })
                }
              }),
              jsx(Button, {
                size: 'sm',
                variant: 'outline',
                disabled: busy || !actionsAllowed || !String(installValue || '').trim(),
                onClick: () => void installFromInput(),
                children: busy ? 'Checking…' : 'Install'
              })
            ]
          }),
          jsx(PreferenceRow, {
            title: 'Enable after install',
            description:
              'Off by default. The Agent half is installed disabled; turn this on only when you want Hermes to activate it immediately after all checks pass.',
            value: enableAfterInstall,
            disabled: busy,
            onChange: value => installEnableAfter.set(Boolean(value))
          }),
          install.message
            ? jsxs('div', {
                className: 'rounded-md border border-(--ui-stroke-secondary) px-3 py-2',
                children: [
                  jsx('div', {
                    className:
                      install.status === 'error' || install.status === 'security-blocked' || install.status === 'core-blocked'
                        ? 'text-red-400'
                        : install.status === 'core-review-required'
                          ? 'text-orange-400'
                          : 'text-(--ui-text-secondary)',
                    children: install.message
                  }),
                  install.probe
                    ? jsx('div', {
                        className: 'mt-1 text-xs text-(--ui-text-tertiary)',
                        children:
                          'Detected: ' +
                          (install.probe.agent ? 'Agent ✓' : 'Agent —') +
                          ' · ' +
                          (install.probe.desktop ? 'Desktop ✓' : 'Desktop —') +
                          (install.sha ? ' · SHA ' + String(install.sha).slice(0, 12) : '')
                      })
                    : null,
                  (install.reviewFindings || []).length
                    ? jsx('div', {
                        className: 'mt-2 flex flex-col gap-1',
                        children: (install.reviewFindings || []).map((finding, index) =>
                          jsxs('div', {
                            className: 'rounded border border-(--ui-stroke-tertiary) px-2 py-1 text-xs',
                            children: [
                              jsx('span', { className: severityClass(finding.severity) + ' font-medium', children: finding.id }),
                              jsx('span', { children: ' · ' + finding.label }),
                              jsx('div', {
                                className: 'break-all text-(--ui-text-tertiary)',
                                children: finding.file + ':' + finding.line
                              })
                            ]
                          }, 'install-review-' + finding.id + '-' + index)
                        )
                      })
                    : null,
                  install.canApproveCore && install.identity && install.sha
                    ? jsx(Button, {
                        size: 'sm',
                        variant: 'outline',
                        className: 'mt-2',
                        disabled: busy,
                        onClick: () => applyCoreApproval(install.identity, install.sha, 'install'),
                        children: 'Allow this exact version'
                      })
                    : null
                ]
              })
            : null
        ]
      }),

      jsxs('div', {
        className: 'grid grid-cols-4 gap-2',
        children: [
          jsx('div', { className: 'rounded-md border border-(--ui-stroke-secondary) p-3', children: 'Missing: ' + state.missing }),
          jsx('div', { className: 'rounded-md border border-(--ui-stroke-secondary) p-3', children: 'Blocked now: ' + blockedNow }),
          jsx('div', {
            className: 'rounded-md border border-(--ui-stroke-secondary) p-3',
            children: 'Security signals: ' + securityFindings.length + (securityCounts.critical ? ' · critical ' + securityCounts.critical : '')
          }),
          jsx('div', {
            className: 'rounded-md border border-(--ui-stroke-secondary) p-3',
            children: 'Core signals: ' + coreFindings.length + (coreCounts.critical ? ' · critical ' + coreCounts.critical : '')
          })
        ]
      }),

      jsxs('div', {
        className: 'grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(360px,2fr)]',
        children: [
          jsxs('section', {
            className: 'flex min-w-0 flex-col gap-2',
            children: [
              jsx('div', { className: 'font-medium', children: 'Plugin halves' }),
              state.halves.length
                ? jsx('div', {
                    className: 'flex flex-col gap-1',
                    children: state.halves.map(item =>
                      jsxs('div', {
                        className: 'grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 rounded-md border border-(--ui-stroke-secondary) px-3 py-2',
                        children: [
                          jsxs('div', {
                            className: 'min-w-0',
                            children: [
                              jsx('div', { className: 'truncate font-medium', children: item.catalog }),
                              jsx('div', {
                                className: 'truncate text-xs text-(--ui-text-tertiary)',
                                children: item.sha ? item.agentStatus + ' · ' + String(item.sha).slice(0, 8) : item.agentStatus
                              })
                            ]
                          }),
                          jsx('span', {
                            children:
                              item.agentExpected === false
                                ? 'Agent —'
                                : item.agent
                                  ? 'Agent ✓'
                                  : item.agentExpected === true
                                    ? 'Agent ✕'
                                    : 'Agent ?'
                          }),
                          jsx('span', {
                            children:
                              item.desktopExpected === false
                                ? 'Desktop —'
                                : item.desktop
                                  ? 'Desktop ✓'
                                  : item.desktopExpected === true
                                    ? 'Desktop ✕'
                                    : 'Desktop ?'
                          }),
                          jsxs('div', {
                            className: 'flex items-center gap-1',
                            children: [
                              item.agent &&
                              item.agentStatus !== 'enabled' &&
                              item.agentKey
                                ? jsx(Button, {
                                    size: 'xs',
                                    variant: 'outline',
                                    disabled: busy || state.running || !actionsAllowed,
                                    onClick: () => void setAgentEnabled(item, true),
                                    children: 'Enable'
                                  })
                                : null,
                              jsx(Button, {
                                size: 'xs',
                                variant: 'outline',
                                disabled: busy || state.running || !actionsAllowed,
                                onClick: () => void uninstallPlugin(item),
                                children: 'Uninstall'
                              })
                            ]
                          })
                        ]
                      }, item.catalog)
                    )
                  })
                : jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'No unified packages detected.' })
            ]
          }),

          jsxs('div', {
            className: 'flex min-w-0 flex-col gap-4',
            children: [
              jsxs('section', {
                className: 'flex flex-col gap-2',
                children: [
                  jsx('div', { className: 'font-medium', children: 'Security preflight' }),
                  jsx('div', {
                    className: 'text-xs text-(--ui-text-tertiary)',
                    children:
                      'Critical = block-worthy malware-like signal. High = powerful/risky capability that needs review. Medium = capability/egress signal. Findings are not proof of malware; Hermes Core scan blocks dangerous server installs before placement.'
                  }),
                  securityFindings.length
                    ? jsx('div', {
                        className: 'flex flex-col gap-1',
                        children: securityFindings.slice(0, 40).map((finding, index) =>
                          jsxs('div', {
                            className: 'rounded-md border border-(--ui-stroke-secondary) px-3 py-2',
                            children: [
                              jsx('span', { className: severityClass(finding.severity) + ' font-medium', children: finding.severity.toUpperCase() + ' ' + finding.id }),
                              jsx('span', { children: ' · ' + finding.plugin + ' · ' + finding.label }),
                              jsx('div', { className: 'break-all text-xs text-(--ui-text-tertiary)', children: finding.file + ':' + finding.line })
                            ]
                          }, finding.id + '-' + index)
                        )
                      })
                    : jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'No findings in the current local Desktop plugin sources.' })
                ]
              }),

              jsxs('section', {
                className: 'flex flex-col gap-2',
                children: [
                  jsx('div', { className: 'font-medium', children: 'Core protection findings' }),
                  jsx('div', {
                    className: 'text-xs text-(--ui-text-tertiary)',
                    children:
                      coreMode === 'smart'
                        ? 'Smart asks before a detected Core change. Exact-version approval is bound to one SHA.'
                        : coreMode === 'strict'
                          ? 'Strict blocks detected Core changes with no exact-version bypass.'
                          : 'Off allows Core changes at the Mender layer; findings remain visible for audit.'
                  }),
                  coreFindings.length
                    ? jsx('div', {
                        className: 'flex flex-col gap-1',
                        children: coreFindings.slice(0, 40).map((finding, index) =>
                          jsxs('div', {
                            className: 'rounded-md border border-(--ui-stroke-secondary) px-3 py-2',
                            children: [
                              jsx('span', {
                                className: severityClass(finding.severity) + ' font-medium',
                                children: finding.severity.toUpperCase() + ' ' + finding.id
                              }),
                              jsx('span', { children: ' · ' + finding.plugin + ' · ' + finding.label }),
                              jsx('div', {
                                className: 'break-all text-xs text-(--ui-text-tertiary)',
                                children: finding.file + ':' + finding.line
                              })
                            ]
                          }, 'core-' + finding.id + '-' + index)
                        )
                      })
                    : jsx('div', {
                        className: 'text-(--ui-text-tertiary)',
                        children: 'No Core-tamper signals in the currently inspected plugin source.'
                      })
                ]
              }),

              jsxs('section', {
                className: 'flex flex-col gap-2',
                children: [
                  jsx('div', { className: 'font-medium', children: 'Last repair actions' }),
                  state.actions.length
                    ? jsx('div', {
                        className: 'flex flex-col gap-1',
                        children: [...state.actions].reverse().slice(0, 20).map((action, index) =>
                          jsxs('div', {
                            className: 'rounded-md border border-(--ui-stroke-secondary) px-3 py-2',
                            children: [
                              jsx('div', {
                                children: (action.plugin || action.type) + ' · ' + action.type + (action.detail ? ' · ' + action.detail : '')
                              }),
                              (action.reviewFindings || []).length
                                ? jsx('div', {
                                    className: 'mt-2 flex flex-col gap-1',
                                    children: (action.reviewFindings || []).map((finding, findingIndex) =>
                                      jsxs('div', {
                                        className: 'rounded border border-(--ui-stroke-tertiary) px-2 py-1 text-xs',
                                        children: [
                                          jsx('span', { className: severityClass(finding.severity) + ' font-medium', children: finding.id }),
                                          jsx('span', { children: ' · ' + finding.label }),
                                          jsx('div', {
                                            className: 'break-all text-(--ui-text-tertiary)',
                                            children: finding.file + ':' + finding.line
                                          })
                                        ]
                                      }, action.type + '-finding-' + findingIndex)
                                    )
                                  })
                                : null,
                              (action.capabilityChanges || []).length
                                ? jsx('div', {
                                    className: 'mt-2 flex flex-col gap-1',
                                    children: (action.capabilityChanges || []).map((line, lineIndex) =>
                                      jsx('div', {
                                        className: 'rounded border border-(--ui-stroke-tertiary) px-2 py-1 text-xs text-(--ui-text-secondary)',
                                        children: line
                                      }, action.type + '-cap-' + lineIndex)
                                    )
                                  })
                                : null,
                              action.canApproveCore && action.approvalIdentity && action.approvalSha
                                ? jsx(Button, {
                                    size: 'xs',
                                    variant: 'outline',
                                    className: 'mt-2',
                                    disabled: busy || state.running || !actionsAllowed,
                                    onClick: () =>
                                      applyCoreApproval(
                                        action.approvalIdentity,
                                        action.approvalSha,
                                        action.resume || 'repair'
                                      ),
                                    children: 'Allow this exact version'
                                  })
                                : null
                            ]
                          }, action.type + '-' + index)
                        )
                      })
                    : jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'No repair actions in the last run.' })
                ]
              })
            ]
          })
        ]
      }),

      jsx('div', {
        className: 'text-xs text-(--ui-text-quaternary)',
        children: state.at ? 'Last check: ' + state.at + ' · ' + (state.reason || '') : 'Not checked yet.'
      })
    ]
  })
}

function MenderStatus() {
  const state = useValue(menderState)
  const compatibility = useValue(compatibilityState)
  const counts = riskCounts(state.findings)
  const label =
    compatibility.status === 'unsupported'
      ? 'Mender unsupported'
      : compatibility.status === 'degraded'
        ? 'Mender degraded'
        : state.running
          ? 'Mender…'
          : state.missing
            ? 'Mender ' + state.missing
            : counts.critical
              ? 'Mender !'
              : 'Mender ✓'

  return jsx('button', {
    type: 'button',
    className: 'px-1.5 text-[0.6875rem] text-(--ui-text-tertiary)',
    onClick: () => host.navigate('/mender'),
    title: 'Open Hermes Mender',
    children: label
  })
}

const plugin = {
  id: ID,
  name: 'Mender',
  register(ctx) {
    pluginStorage = ctx.storage
    const savedMode = ctx.storage.get('security.mode', 'smart')
    securityMode.set(SECURITY_MODES.has(savedMode) ? savedMode : 'smart')
    const savedCoreMode = ctx.storage.get('coreProtection.mode', 'smart')
    coreProtectionMode.set(CORE_PROTECTION_MODES.has(savedCoreMode) ? savedCoreMode : 'smart')
    const savedApprovals = ctx.storage.get('coreProtection.approvals', {})
    coreVersionApprovals.set(savedApprovals && typeof savedApprovals === 'object' ? savedApprovals : {})
    respectUninstallIntent.set(Boolean(ctx.storage.get('repair.respectUninstallIntent', true)))
    autoEnableRepairedAgents.set(Boolean(ctx.storage.get('repair.autoEnableAgents', false)))

    void checkCompatibility(true).then(() => reconcile('startup'))
    void startDirectoryWatch().catch(error => warn('directory watch unavailable:', String(error)))

    if (window.hermesDesktop?.onConnectionApplied) {
      stopConnectionApplied = window.hermesDesktop.onConnectionApplied(() => {
        compatibilityLastCheckedAt = 0
        void checkCompatibility(true).then(() => reconcile('connection-applied'))
      })
    }

    timer = setInterval(() => {
      void reconcile('timer')
    }, CHECK_MS)

    ctx.onDispose?.(() => {
      if (timer) clearInterval(timer)
      timer = null
      stopDirectoryEvents?.()
      stopDirectoryEvents = null
      stopConnectionApplied?.()
      stopConnectionApplied = null

      if (directoryWatchId && window.hermesDesktop?.stopPreviewFileWatch) {
        void window.hermesDesktop.stopPreviewFileWatch(directoryWatchId).catch(() => undefined)
      }
      directoryWatchId = null
      pluginStorage = null
    })
    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: '/mender' },
      render: () => jsx(MenderPage, {})
    })

    ctx.register({
      id: 'status',
      area: STATUSBAR_AREAS.right,
      order: 170,
      render: () => jsx(MenderStatus, {})
    })

    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: ID + '.open',
        label: 'Mender: open status',
        keywords: ['plugin', 'repair', 'security', 'catalog'],
        run: () => host.navigate('/mender')
      }
    })

    ctx.register({
      id: 'reconcile',
      area: PALETTE_AREA,
      data: {
        id: ID + '.reconcile',
        label: 'Mender: repair plugin halves now',
        keywords: ['plugin', 'repair', 'reconcile', 'catalog'],
        run: () => void reconcile('manual')
      }
    })
  }
}

export default plugin
export const __test = { extractPluginId, githubRepoSlug, scanSource, hasBlockingFinding, scanCoreTamperSource, hasCoreProtectionBlocker, runPreflight, preflightDecision, coreApprovalKey, coreApprovalEffective, setCoreVersionApproval, isCoreVersionApproved, evaluateCompatibilityChecks, parseGitHubInstallIdentifier, shouldScanRuntimePath, catalogEntryForLocal, isExpectedMissingHalf, shouldTreatAsIntentionalAgentRemoval, desktopUpdateTextFile, safeCliPluginName }