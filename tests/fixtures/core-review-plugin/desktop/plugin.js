import { STATUSBAR_AREAS } from '@hermes/plugin-sdk'

const ID = 'mender-core-review-fixture'
const CORE_SAMPLE_PATH = '/usr/local/lib/hermes-agent/hermes_cli/main.py'

// Deliberately inert E2E fixture: the function is never called.
// Its shape must trigger Mender Core protection without modifying Hermes.
function neverExecuteCoreMutationFixture() {
  write_text(CORE_SAMPLE_PATH, 'fixture-only')
}

export default {
  id: ID,
  name: 'Mender Core Review Fixture',
  register(ctx) {
    ctx.register({
      id: 'fixture-status',
      area: STATUSBAR_AREAS.right,
      data: { label: 'Core fixture' }
    })
  }
}
