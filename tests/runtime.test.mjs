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
assert.equal(t.hasBlockingFinding(high, 'strict'), true, 'strict blocks high')
assert.equal(t.hasBlockingFinding(high, 'off'), false, 'off never blocks Mender preflight')

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
  false,
  'desktop-only plugins are not missing an agent half'
)
assert.equal(
  t.isExpectedMissingHalf({ agentExpected: true, agent: false, desktopExpected: true, desktop: true }),
  true,
  'unified package with missing agent half is missing'
)

const previousComplete = { agent: true, desktop: true }
const nowAgentGone = { agentExpected: true, desktopExpected: true, agent: false, desktop: true }
assert.equal(
  t.shouldTreatAsIntentionalAgentRemoval(previousComplete, nowAgentGone, 'timer'),
  true,
  'automatic reconcile treats a previously-complete package losing its agent half as uninstall intent'
)
assert.equal(
  t.shouldTreatAsIntentionalAgentRemoval(previousComplete, nowAgentGone, 'manual'),
  false,
  'manual Repair now overrides the uninstall tombstone'
)
assert.equal(
  t.shouldTreatAsIntentionalAgentRemoval({ agent: false, desktop: true }, nowAgentGone, 'timer'),
  false,
  'first-time incomplete installs are still repairable'
)

assert.equal(t.desktopUpdateTextFile('plugin.js'), true)
assert.equal(t.desktopUpdateTextFile('theme.css'), true)
assert.equal(t.desktopUpdateTextFile('icon.svg'), true)
assert.equal(t.desktopUpdateTextFile('payload.bin'), false)

console.log('mender-runtime: ok')