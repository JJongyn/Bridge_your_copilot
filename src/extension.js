const crypto = require('crypto')
const http = require('http')
const vscode = require('vscode')

const {
  attachSseHeartbeat,
  createBridgeRequestHandler,
  startSse,
  writeSseEvent
} = require('./http-handler')
const {
  buildModelMetadata,
  describeModel,
  normalizeString,
  pickInitialModel,
  resolveRequestedModel
} = require('./model-selection')

const EXTENSION_NAME = 'Bridge your Copilot'
const CONFIG_SECTION = 'bridgeYourCopilot'
const TOKEN_HEADER = 'x-bridge-your-copilot-token'
const TOKEN_SECRET_KEY = 'bridge-your-copilot.auth-token'

let outputChannel
let server
let selectedModel
let availableModels = []
let selectedModelSummary = 'uninitialized'
let extensionContext
let runtimeAuthToken = ''

function assertLanguageModelApiAvailable() {
  if (
    !vscode.lm ||
    typeof vscode.lm.selectChatModels !== 'function' ||
    !vscode.LanguageModelChatMessage ||
    !vscode.LanguageModelTextPart
  ) {
    throw new Error(
      'This extension requires VS Code 1.91 or newer with the Language Model API available.'
    )
  }
}

function getConfig() {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION)
  return {
    host: config.get('host', '127.0.0.1'),
    port: config.get('port', 8765),
    modelFamily: normalizeString(config.get('modelFamily', '')),
    defaultInstruction: config.get('defaultInstruction', '') || '',
    authToken: normalizeString(config.get('authToken', ''))
  }
}

function log(message) {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`)
}

function getAuthorizationToken(req) {
  const bearer = req.headers.authorization
  if (typeof bearer === 'string' && bearer.startsWith('Bearer ')) {
    return bearer.slice('Bearer '.length).trim()
  }

  const header = req.headers[TOKEN_HEADER]
  if (Array.isArray(header)) {
    return header[0]
  }

  return typeof header === 'string' ? header : ''
}

async function getStoredAuthToken() {
  if (!extensionContext) {
    return ''
  }

  return (await extensionContext.secrets.get(TOKEN_SECRET_KEY)) || ''
}

async function persistAuthToken(token) {
  runtimeAuthToken = token
  await extensionContext.secrets.store(TOKEN_SECRET_KEY, token)
  return runtimeAuthToken
}

async function loadRuntimeAuthToken() {
  const configuredToken = getConfig().authToken
  if (configuredToken) {
    runtimeAuthToken = configuredToken
    return runtimeAuthToken
  }

  runtimeAuthToken = await getStoredAuthToken()
  return runtimeAuthToken
}

async function ensureRuntimeAuthToken() {
  const configuredToken = getConfig().authToken
  if (configuredToken) {
    runtimeAuthToken = configuredToken
    return runtimeAuthToken
  }

  if (runtimeAuthToken) {
    return runtimeAuthToken
  }

  const storedToken = await getStoredAuthToken()
  if (storedToken) {
    runtimeAuthToken = storedToken
    return runtimeAuthToken
  }

  return persistAuthToken(crypto.randomBytes(24).toString('hex'))
}

async function rotateRuntimeAuthToken() {
  if (getConfig().authToken) {
    throw new Error(
      'bridgeYourCopilot.authToken is set in VS Code settings. Remove it before rotating the generated token.'
    )
  }

  return persistAuthToken(crypto.randomBytes(24).toString('hex'))
}

function buildModelList() {
  return availableModels.map(model => buildModelMetadata(model, selectedModel))
}

function buildHealthPayload() {
  return {
    ok: true,
    status: server ? 'running' : 'stopped',
    model: selectedModelSummary,
    selected_model_id: selectedModel ? selectedModel.id : null,
    available_model_count: availableModels.length,
    token_configured: Boolean(runtimeAuthToken)
  }
}

function buildConnectionInfo() {
  const config = getConfig()
  return {
    baseUrl: `http://${config.host}:${config.port}/v1`,
    healthUrl: `http://${config.host}:${config.port}/healthz`,
    token: runtimeAuthToken || '(not configured)',
    model: selectedModel ? describeModel(selectedModel) : 'unselected',
    availableModelCount: availableModels.length
  }
}

async function refreshAvailableModelsFromUserAction() {
  assertLanguageModelApiAvailable()
  log('Loading available Copilot models')
  availableModels = await vscode.lm.selectChatModels({ vendor: 'copilot' })

  if (!availableModels.length) {
    throw new Error(
      'No Copilot models are available. Confirm that GitHub Copilot is enabled and that model access has been approved in VS Code.'
    )
  }

  return availableModels
}

function setSelectedModel(model) {
  selectedModel = model
  selectedModelSummary = describeModel(model)
  log(`Selected default model ${selectedModelSummary}`)
  return selectedModel
}

async function selectModelFromUserAction(requestedModel) {
  const config = getConfig()
  const models = await refreshAvailableModelsFromUserAction()
  return setSelectedModel(pickInitialModel(models, requestedModel || config.modelFamily))
}

async function pickModelFromQuickPick() {
  const models = await refreshAvailableModelsFromUserAction()
  const items = models.map(model => ({
    label: model.family || model.id,
    description: model.id,
    detail: `${model.vendor} | version ${model.version || 'unknown'} | max input ${model.maxInputTokens || 'unknown'}${selectedModel && model.id === selectedModel.id ? ' | selected' : ''}`,
    model
  }))

  const choice = await vscode.window.showQuickPick(items, {
    title: `${EXTENSION_NAME}: Select Model`,
    placeHolder: 'Choose which Copilot model to use by default'
  })

  if (!choice) {
    return undefined
  }

  return setSelectedModel(choice.model)
}

async function resolveModelForPayload(payload) {
  if (!availableModels.length) {
    await refreshAvailableModelsFromUserAction()
  }

  if (selectedModel) {
    return resolveRequestedModel({
      availableModels,
      selectedModel,
      payloadModel: payload && payload.model,
      payloadModelFamily: payload && payload.modelFamily
    }).model
  }

  const requestedModel = normalizeString(payload && payload.model)
  const requestedFamily = normalizeString(payload && payload.modelFamily)
  const requested = requestedModel && requestedModel !== 'copilot' ? requestedModel : requestedFamily

  if (!requested) {
    return selectModelFromUserAction()
  }

  return resolveRequestedModel({
    availableModels,
    selectedModel: pickInitialModel(availableModels),
    payloadModel: requestedModel,
    payloadModelFamily: requestedFamily
  }).model
}

function normalizeContent(content) {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (!part || typeof part !== 'object') {
          return ''
        }

        if (part.type === 'text' && typeof part.text === 'string') {
          return part.text
        }

        if (typeof part.content === 'string') {
          return part.content
        }

        return ''
      })
      .filter(Boolean)
      .join('\n')
  }

  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text
  }

  return ''
}

function appendUserInstruction(messages, instruction) {
  const text = normalizeString(instruction)
  if (text) {
    messages.push(vscode.LanguageModelChatMessage.User(text))
  }
}

function createBridgeMessages(payload, config) {
  const messages = []
  appendUserInstruction(messages, config.defaultInstruction)
  appendUserInstruction(messages, payload.instruction)

  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    for (const message of payload.messages) {
      const content = normalizeContent(message && message.content)
      if (!content) {
        throw new Error('Each message must include string content.')
      }

      if (message.role === 'assistant') {
        messages.push(vscode.LanguageModelChatMessage.Assistant(content))
      } else {
        messages.push(vscode.LanguageModelChatMessage.User(content))
      }
    }
    return messages
  }

  if (typeof payload.prompt === 'string' && payload.prompt.trim()) {
    messages.push(vscode.LanguageModelChatMessage.User(payload.prompt))
    return messages
  }

  throw new Error('Request must include either prompt or messages.')
}

function createOpenAIChatMessages(payload, config) {
  const messages = []
  appendUserInstruction(messages, config.defaultInstruction)
  appendUserInstruction(messages, payload.instructions)

  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new Error('OpenAI-compatible requests require a non-empty messages array.')
  }

  for (const message of payload.messages) {
    const content = normalizeContent(message && message.content)
    if (!content) {
      continue
    }

    if (message.role === 'assistant') {
      messages.push(vscode.LanguageModelChatMessage.Assistant(content))
    } else {
      messages.push(vscode.LanguageModelChatMessage.User(content))
    }
  }

  if (!messages.length) {
    throw new Error('No supported text content found in messages.')
  }

  return messages
}

function extractTextPart(chunk) {
  if (chunk instanceof vscode.LanguageModelTextPart) {
    return chunk.value
  }

  if (typeof chunk === 'string') {
    return chunk
  }

  if (chunk && typeof chunk.value === 'string') {
    return chunk.value
  }

  return ''
}

async function startModelRequest(messages, payload) {
  const model = await resolveModelForPayload(payload)
  const tokenSource = new vscode.CancellationTokenSource()
  const response = await model.sendRequest(messages, {}, tokenSource.token)
  return { model, response, tokenSource }
}

async function consumeModelText(request, onTextPart) {
  let text = ''

  try {
    for await (const chunk of request.response.stream) {
      const delta = extractTextPart(chunk)
      if (!delta) {
        continue
      }

      text += delta
      if (onTextPart) {
        await onTextPart(delta, text, request.model)
      }
    }
  } finally {
    request.tokenSource.dispose()
  }

  return text
}

async function generateText(messages, payload) {
  const request = await startModelRequest(messages, payload)
  const text = await consumeModelText(request)
  return { model: request.model, text }
}

function makeBridgeResponse(model, text) {
  return {
    model: {
      id: model.id,
      family: model.family,
      version: model.version,
      vendor: model.vendor,
      maxInputTokens: model.maxInputTokens
    },
    content: text
  }
}

function createCompletionId() {
  return `chatcmpl-${Date.now()}`
}

function makeOpenAIChatCompletion(model, completionId, created, text) {
  return {
    id: completionId,
    object: 'chat.completion',
    created,
    model: model.id,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text
        },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  }
}

function makeOpenAIStreamChunk(model, completionId, created, delta, finishReason) {
  return {
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model: model.id,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason || null
      }
    ]
  }
}

async function handleBridgeChat(payload) {
  const config = getConfig()
  const messages = createBridgeMessages(payload, config)
  const { model, text } = await generateText(messages, payload)
  log(`Forwarding bridge request with ${messages.length} prompt messages to ${describeModel(model)}`)
  return makeBridgeResponse(model, text)
}

async function handleOpenAIChatCompletion(payload) {
  const config = getConfig()
  const messages = createOpenAIChatMessages(payload, config)
  const { model, text } = await generateText(messages, payload)
  log(
    `Forwarding OpenAI-compatible request with ${messages.length} prompt messages to ${describeModel(model)}`
  )
  return makeOpenAIChatCompletion(model, createCompletionId(), Math.floor(Date.now() / 1000), text)
}

async function streamBridgeChat(payload, req, res) {
  const config = getConfig()
  const messages = createBridgeMessages(payload, config)
  const request = await startModelRequest(messages, payload)
  const stopHeartbeat = attachSseHeartbeat(res)

  startSse(res)
  writeSseEvent(res, { model: buildModelMetadata(request.model, selectedModel) }, 'ready')
  log(`Streaming bridge request with ${messages.length} prompt messages to ${describeModel(request.model)}`)

  const closeListener = () => {
    log('Native stream client disconnected.')
    request.tokenSource.cancel()
  }
  req.on('close', closeListener)

  try {
    await consumeModelText(request, delta => {
      writeSseEvent(res, { delta }, 'chunk')
    })
    writeSseEvent(
      res,
      { done: true, model: buildModelMetadata(request.model, selectedModel) },
      'done'
    )
    res.end()
  } finally {
    stopHeartbeat()
    req.off('close', closeListener)
  }
}

async function streamOpenAIChatCompletion(payload, req, res) {
  const config = getConfig()
  const messages = createOpenAIChatMessages(payload, config)
  const request = await startModelRequest(messages, payload)
  const completionId = createCompletionId()
  const created = Math.floor(Date.now() / 1000)
  const stopHeartbeat = attachSseHeartbeat(res)

  startSse(res)
  log(
    `Streaming OpenAI-compatible request with ${messages.length} prompt messages to ${describeModel(request.model)}`
  )

  const closeListener = () => {
    log('OpenAI-compatible stream client disconnected.')
    request.tokenSource.cancel()
  }
  req.on('close', closeListener)

  try {
    writeSseEvent(
      res,
      makeOpenAIStreamChunk(request.model, completionId, created, { role: 'assistant' }, null)
    )

    await consumeModelText(request, delta => {
      writeSseEvent(
        res,
        makeOpenAIStreamChunk(request.model, completionId, created, { content: delta }, null)
      )
    })

    writeSseEvent(res, makeOpenAIStreamChunk(request.model, completionId, created, {}, 'stop'))
    writeSseEvent(res, '[DONE]')
    res.end()
  } finally {
    stopHeartbeat()
    req.off('close', closeListener)
  }
}

async function copyAccessToken() {
  const token = await ensureRuntimeAuthToken()
  await vscode.env.clipboard.writeText(token)
  vscode.window.showInformationMessage(`${EXTENSION_NAME} access token copied to clipboard.`)
}

async function copyConnectionInfo() {
  const info = buildConnectionInfo()
  const text = [
    `BASE_URL=${info.baseUrl}`,
    `AUTH_TOKEN=${info.token}`,
    `MODEL=${info.model}`,
    `AVAILABLE_MODELS=${info.availableModelCount}`
  ].join('\n')

  await vscode.env.clipboard.writeText(text)
  vscode.window.showInformationMessage(`${EXTENSION_NAME} connection info copied to clipboard.`)
}

async function rotateAccessToken() {
  const token = await rotateRuntimeAuthToken()
  await vscode.env.clipboard.writeText(token)
  vscode.window.showInformationMessage(
    `${EXTENSION_NAME} rotated the generated access token and copied it to clipboard.`
  )
}

async function revealModelDetails() {
  if (!availableModels.length) {
    await refreshAvailableModelsFromUserAction()
  }

  const lines = [
    `${EXTENSION_NAME} model details`,
    `Selected: ${selectedModel ? describeModel(selectedModel) : 'none'}`,
    `Available: ${availableModels.length}`,
    ''
  ]

  for (const model of availableModels) {
    lines.push(
      `- ${model.id} | family=${model.family} | vendor=${model.vendor} | version=${model.version || 'unknown'} | maxInput=${model.maxInputTokens || 'unknown'}${selectedModel && model.id === selectedModel.id ? ' | selected' : ''}`
    )
  }

  outputChannel.clear()
  outputChannel.appendLine(lines.join('\n'))
  outputChannel.show(true)
  vscode.window.showInformationMessage(`${EXTENSION_NAME} model details opened in the output panel.`)
}

async function startServer() {
  if (server) {
    vscode.window.showInformationMessage(`${EXTENSION_NAME} server is already running.`)
    return
  }

  await ensureRuntimeAuthToken()
  await selectModelFromUserAction()
  const config = getConfig()

  const requestHandler = createBridgeRequestHandler({
    getHealth: () => ({
      host: config.host,
      port: config.port,
      payload: buildHealthPayload()
    }),
    getModels: buildModelList,
    getExpectedAuthToken: () => runtimeAuthToken,
    getAuthorizationToken,
    handleBridgeChat,
    handleOpenAIChatCompletion,
    streamBridgeChat,
    streamOpenAIChatCompletion,
    log,
    isLanguageModelError: error => error instanceof vscode.LanguageModelError,
    getLanguageModelErrorCode: error => error.code
  })

  server = http.createServer(requestHandler)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, resolve)
  })

  log(`${EXTENSION_NAME} listening on http://${config.host}:${config.port}`)
  const action = await vscode.window.showInformationMessage(
    `${EXTENSION_NAME} listening on http://${config.host}:${config.port}`,
    'Copy Token',
    'Copy Connection Info',
    'Reveal Models'
  )

  if (action === 'Copy Token') {
    await copyAccessToken()
  } else if (action === 'Copy Connection Info') {
    await copyConnectionInfo()
  } else if (action === 'Reveal Models') {
    await revealModelDetails()
  }
}

async function stopServer() {
  if (!server) {
    vscode.window.showInformationMessage(`${EXTENSION_NAME} server is not running.`)
    return
  }

  await new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })

  log(`${EXTENSION_NAME} server stopped`)
  server = undefined
  selectedModel = undefined
  availableModels = []
  selectedModelSummary = 'stopped'
  vscode.window.showInformationMessage(`${EXTENSION_NAME} server stopped.`)
}

function showStatus() {
  const info = buildConnectionInfo()
  const state = server ? 'running' : 'stopped'
  vscode.window.showInformationMessage(
    `${EXTENSION_NAME} is ${state} on ${info.baseUrl} using ${info.model} with ${info.availableModelCount} discovered models`
  )
}

function registerCommand(context, command, handler) {
  context.subscriptions.push(
    vscode.commands.registerCommand(command, async () => {
      try {
        await handler()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`Command ${command} failed: ${message}`)
        vscode.window.showErrorMessage(`${EXTENSION_NAME}: ${message}`)
      }
    })
  )
}

function activate(context) {
  extensionContext = context
  outputChannel = vscode.window.createOutputChannel(EXTENSION_NAME)
  context.subscriptions.push(outputChannel)

  if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
    log('Language Model API not available. VS Code 1.91 or newer is required.')
  }

  void loadRuntimeAuthToken()

  registerCommand(context, 'bridgeYourCopilot.startServer', startServer)
  registerCommand(context, 'bridgeYourCopilot.stopServer', stopServer)
  registerCommand(context, 'bridgeYourCopilot.showStatus', showStatus)
  registerCommand(context, 'bridgeYourCopilot.selectModel', async () => {
    const model = await pickModelFromQuickPick()
    if (model) {
      vscode.window.showInformationMessage(
        `${EXTENSION_NAME} selected model: ${describeModel(model)}`
      )
    }
  })
  registerCommand(context, 'bridgeYourCopilot.copyAccessToken', copyAccessToken)
  registerCommand(context, 'bridgeYourCopilot.copyConnectionInfo', copyConnectionInfo)
  registerCommand(context, 'bridgeYourCopilot.rotateAccessToken', rotateAccessToken)
  registerCommand(context, 'bridgeYourCopilot.revealModelDetails', revealModelDetails)
}

async function deactivate() {
  if (server) {
    await stopServer()
  }
}

module.exports = {
  activate,
  deactivate
}
