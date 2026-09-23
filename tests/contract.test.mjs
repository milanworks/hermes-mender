import fs from 'node:fs'
import assert from 'node:assert/strict'

const source = fs.readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')
const version = fs.readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim()

assert.match(source, /const ID = 'hermes-mender'/)
assert.ok(source.includes("const VERSION = '" + version + "'"))

assert.match(source, /host\.request\('plugins\.manage'/)
assert.match(source, /action: 'install'/)
assert.match(source, /catalog_name: entry\.name/)
assert.match(source, /enable: true/)
assert.match(source, /probePluginRepo/)
assert.match(source, /fetchPinnedRuntimeFiles/)

assert.match(source, /installDesktopPlugin/)
assert.match(source, /force: false/)
assert.doesNotMatch(source, /force:\s*true/)
assert.match(source, /watchDirectory/)
assert.doesNotMatch(source, /row\.status\s*!==\s*['"]enabled['"]/)

assert.match(source, /hasBlockingFinding/)
assert.match(source, /SECURITY_MODES/)
assert.match(source, /security\.mode/)
assert.match(source, /Smart:/)
assert.match(source, /Strict:/)
assert.match(source, /Off:/)
assert.match(source, /scanSource/)
assert.match(source, /SECURITY_RULES/)
assert.match(source, /MND001/)
assert.match(source, /MND003/)

assert.match(source, /ROUTES_AREA/)
assert.match(source, /STATUSBAR_AREAS\.right/)
assert.match(source, /path: '\/mender'/)
assert.match(source, /MenderPage/)
assert.match(source, /MenderStatus/)
assert.match(source, /buildHalfRows/)
assert.match(source, /mender-state\.json/)

console.log('mender-contract: ok')