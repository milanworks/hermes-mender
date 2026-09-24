import fs from 'node:fs'
import assert from 'node:assert/strict'

let source = fs.readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

source = source.replace(
  /import \{[\s\S]*?\} from '@hermes\/plugin-sdk'/,
  "const host = {}; const atom = v => ({ get: () => v, set: n => { v = n } }); const useValue = a => a.get(); const Button = function() {}; const ROUTES_AREA = 'routes'; const STATUSBAR_AREAS = { right: 'status-right' }; const PALETTE_AREA = 'palette'"
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

assert.equal(t.shouldScanRuntimePath('plugin.yaml'), true)
assert.equal(t.shouldScanRuntimePath('src/plugin.py'), true)
assert.equal(t.shouldScanRuntimePath('tests/test_plugin.py'), false)
assert.equal(t.shouldScanRuntimePath('docs/example.js'), false)

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