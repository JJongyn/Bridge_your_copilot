const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_MODEL_PREFERENCES,
  findModelMatch,
  pickInitialModel,
  resolveRequestedModel
} = require('../src/model-selection')

const models = [
  {
    id: 'gpt-4o-mini',
    family: 'gpt-4o-mini',
    vendor: 'copilot',
    version: '2026-01-01',
    maxInputTokens: 128000
  },
  {
    id: 'gpt-5-mini',
    family: 'gpt-5 mini',
    vendor: 'copilot',
    version: '2026-02-01',
    maxInputTokens: 256000
  }
]

test('default preferences include GPT-5 mini aliases', () => {
  assert.ok(DEFAULT_MODEL_PREFERENCES.includes('gpt-5.1 mini'))
  assert.ok(DEFAULT_MODEL_PREFERENCES.includes('gpt-5 mini'))
})

test('findModelMatch resolves by family and id aliases', () => {
  assert.equal(findModelMatch('gpt-5 mini', models).id, 'gpt-5-mini')
  assert.equal(findModelMatch('copilot/gpt-4o-mini', models).id, 'gpt-4o-mini')
})

test('pickInitialModel prefers GPT-5 mini when no explicit request is provided', () => {
  assert.equal(pickInitialModel(models).id, 'gpt-5-mini')
})

test('resolveRequestedModel throws actionable error for missing models', () => {
  assert.throws(
    () =>
      resolveRequestedModel({
        availableModels: models,
        selectedModel: models[0],
        payloadModel: 'claude-4-opus',
        payloadModelFamily: ''
      }),
    error => error.code === 'MODEL_NOT_AVAILABLE' && /GET \/v1\/models/.test(error.message)
  )
})
