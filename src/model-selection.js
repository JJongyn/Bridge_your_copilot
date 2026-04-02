const DEFAULT_MODEL_PREFERENCES = [
  'gpt-5.1 mini',
  'gpt-5.1-mini',
  'gpt-5 mini',
  'gpt-5-mini'
]

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function describeModel(model) {
  return `${model.vendor}/${model.family} (${model.id})`
}

function buildModelMetadata(model, selectedModel) {
  return {
    id: model.id,
    object: 'model',
    created: 0,
    owned_by: model.vendor,
    family: model.family,
    version: model.version,
    max_input_tokens: model.maxInputTokens,
    selected: Boolean(selectedModel && model.id === selectedModel.id)
  }
}

function buildModelCandidates(model) {
  return [
    model.id,
    model.family,
    `${model.vendor}/${model.family}`,
    `${model.vendor}/${model.id}`,
    `${model.family}:${model.version || ''}`,
    `${model.vendor}/${model.family}:${model.version || ''}`
  ]
}

function findModelMatch(requestedModel, availableModels) {
  const requested = normalizeString(requestedModel).toLowerCase()
  if (!requested || requested === 'copilot') {
    return undefined
  }

  return availableModels.find(model =>
    buildModelCandidates(model).some(candidate => normalizeString(candidate).toLowerCase() === requested)
  )
}

function pickInitialModel(models, requestedModel) {
  if (requestedModel) {
    return findModelMatch(requestedModel, models) || models[0]
  }

  for (const candidate of DEFAULT_MODEL_PREFERENCES) {
    const matched = findModelMatch(candidate, models)
    if (matched) {
      return matched
    }
  }

  return models[0]
}

function resolveRequestedModel({
  availableModels,
  selectedModel,
  payloadModel,
  payloadModelFamily
}) {
  const requestedModel = normalizeString(payloadModel)
  const requestedFamily = normalizeString(payloadModelFamily)
  const requested =
    requestedModel && requestedModel !== 'copilot' ? requestedModel : requestedFamily

  if (!requested) {
    return { model: selectedModel }
  }

  const matchedModel = findModelMatch(requested, availableModels)
  if (!matchedModel) {
    const available = availableModels.map(model => model.id).join(', ')
    const error = new Error(
      `Requested model "${requested}" is not available. Call GET /v1/models to inspect supported models.`
    )
    error.code = 'MODEL_NOT_AVAILABLE'
    error.detail = available
    throw error
  }

  return { model: matchedModel }
}

module.exports = {
  DEFAULT_MODEL_PREFERENCES,
  buildModelMetadata,
  describeModel,
  findModelMatch,
  normalizeString,
  pickInitialModel,
  resolveRequestedModel
}
