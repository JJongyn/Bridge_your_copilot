const crypto = require('crypto')
const http = require('http')
const vscode = require('vscode')

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
    modelFamily: (config.get('modelFamily', '') || '').trim(),
    defaultInstruction: config.get('defaultInstruction', '') || '',
    authToken: config.get('authToken', '') || ''
  }
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function log(message) {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`)
}

function buildModelMetadata(model) {
  return {
    id: model.id,
    family: model.family,
    version: model.version,
    vendor: model.vendor,
    maxInputTokens: model.maxInputTokens
  }
}

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload, 'utf8')
  })
  res.end(payload)
}

function errorBody(message, type = 'invalid_request_error', code) {
  return {
    error: {
      message,
      type,
      code: code || null
    }
  }
}

function errorResponse(res, statusCode, message, type = 'invalid_request_error', code) {
  jsonResponse(res, statusCode, errorBody(message, type, code))
}

function startSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders()
  }
}

function writeSseEvent(res, data, eventName) {
  if (eventName) {
    res.write(`event: ${eventName}\n`)
  }
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''

    req.on('data', chunk => {
      body += chunk
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'))
        req.destroy()
      }
    })

    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
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
  const text = typeof instruction === 'string' ? instruction.trim() : ''
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
        throw new Error('Each message must include string content')
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

  throw new Error('Request must include either prompt or messages')
}

function createOpenAIChatMessages(payload, config) {
  const messages = []

  appendUserInstruction(messages, config.defaultInstruction)

  if (typeof payload.instructions === 'string' && payload.instructions.trim()) {
    messages.push(vscode.LanguageModelChatMessage.User(payload.instructions))
  }

  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new Error('OpenAI-compatible requests require a non-empty messages array')
  }

  for (const message of payload.messages) {
    const content = normalizeContent(message && message.content)
    if (!content) {
      continue
    }

    if (message.role === 'assistant') {
      messages.push(vscode.LanguageModelChatMessage.Assistant(content))
      continue
    }

    messages.push(vscode.LanguageModelChatMessage.User(content))
  }

  if (messages.length === 0) {
    throw new Error('No supported text content found in messages')
  }

  return messages
}

function getSelectedModelInfo() {
  return availableModels.map(model => ({
    id: model.id,
    object: 'model',
    created: 0,
    owned_by: model.vendor,
    family: model.family,
    version: model.version,
    max_input_tokens: model.maxInputTokens,
    selected: selectedModel ? model.id === selectedModel.id : false
  }))
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

function isAuthorized(req, expectedToken) {
  if (!expectedToken) {
    return true
  }

  return getAuthorizationToken(req) === expectedToken
}

async function getStoredAuthToken() {
  if (!extensionContext) {
    return ''
  }

  return (await extensionContext.secrets.get(TOKEN_SECRET_KEY)) || ''
}

async function loadRuntimeAuthToken() {
  const configuredToken = normalizeString(getConfig().authToken)
  if (configuredToken) {
    runtimeAuthToken = configuredToken
    return runtimeAuthToken
  }

  runtimeAuthToken = await getStoredAuthToken()
  return runtimeAuthToken
}

async function ensureRuntimeAuthToken() {
  const configuredToken = normalizeString(getConfig().authToken)
  if (configuredToken) {
    runtimeAuthToken = configuredToken
    return runtimeAuthToken
  }

  const storedToken = await getStoredAuthToken()
  if (storedToken) {
    runtimeAuthToken = storedToken
    return runtimeAuthToken
  }

  runtimeAuthToken = crypto.randomBytes(24).toString('hex')
  await extensionContext.secrets.store(TOKEN_SECRET_KEY, runtimeAuthToken)
  return runtimeAuthToken
}

function describeModel(model) {
  return `${model.vendor}/${model.family} (${model.id})`
}

function findModelMatch(requestedModel) {
  const requested = normalizeString(requestedModel).toLowerCase()
  if (!requested || requested === 'copilot') {
    return undefined
  }

  return availableModels.find(model => {
    const candidates = [
      model.id,
      model.family,
      `${model.vendor}/${model.family}`,
      `${model.vendor}/${model.id}`,
      `${model.family}:${model.version || ''}`,
      `${model.vendor}/${model.family}:${model.version || ''}`
    ]

    return candidates.some(candidate => normalizeString(candidate).toLowerCase() === requested)
  })
}

function pickInitialModel(models, requestedModel) {
  return findModelMatch(requestedModel) || models[0]
}

async function refreshAvailableModelsFromUserAction() {
  assertLanguageModelApiAvailable()
  log('Loading available Copilot models')
  availableModels = await vscode.lm.selectChatModels({ vendor: 'copilot' })

  if (!availableModels.length) {
    throw new Error('No Copilot models available')
  }

  return availableModels
}

function setSelectedModel(model) {
  selectedModel = model
  selectedModelSummary = describeModel(model)
  log(`Selected model ${selectedModelSummary}`)
  return selectedModel
}

async function selectModelFromUserAction(requestedModel) {
  const config = getConfig()
  const models = await refreshAvailableModelsFromUserAction()
  const preferredModel = pickInitialModel(models, requestedModel || config.modelFamily)

  if (!preferredModel) {
    throw new Error('No Copilot models available')
  }

  return setSelectedModel(preferredModel)
}

async function pickModelFromQuickPick() {
  const models = await refreshAvailableModelsFromUserAction()
  const items = models.map(model => ({
    label: model.family || model.id,
    description: model.id,
    detail: `${model.vendor} | version ${model.version || 'unknown'} | max input ${model.maxInputTokens || 'unknown'}`,
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

  const requestedModel = normalizeString(payload && payload.model)
  const requestedFamily = normalizeString(payload && payload.modelFamily)
  const requested = requestedModel && requestedModel !== 'copilot' ? requestedModel : requestedFamily

  if (!requested) {
    if (selectedModel) {
      return selectedModel
    }
    return selectModelFromUserAction()
  }

  const matchedModel = findModelMatch(requested)
  if (!matchedModel) {
    throw new Error(
      `Requested model "${requested}" is not available. Call GET /v1/models to inspect supported models.`
    )
  }

  return matchedModel
}

async function ensureModelAvailable() {
  if (selectedModel) {
    return selectedModel
  }

  throw new Error(
    `No model selected. Run "${EXTENSION_NAME}: Start Server" from the Command Palette first.`
  )
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
    model: buildModelMetadata(model),
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
  log(`Forwarding OpenAI-compatible request with ${messages.length} prompt messages to ${describeModel(model)}`)
  return makeOpenAIChatCompletion(model, createCompletionId(), Math.floor(Date.now() / 1000), text)
}

async function streamBridgeChat(payload, req, res) {
  const config = getConfig()
  const messages = createBridgeMessages(payload, config)
  const request = await startModelRequest(messages, payload)
  const closeListener = () => request.tokenSource.cancel()

  log(`Streaming bridge request with ${messages.length} prompt messages to ${describeModel(request.model)}`)
  req.on('close', closeListener)
  startSse(res)

  try {
    await consumeModelText(request, delta => {
      writeSseEvent(res, { delta }, 'chunk')
    })
    writeSseEvent(res, { done: true, model: buildModelMetadata(request.model) }, 'done')
    res.end()
  } finally {
    req.off('close', closeListener)
  }
}

async function streamOpenAIChatCompletion(payload, req, res) {
  const config = getConfig()
  const messages = createOpenAIChatMessages(payload, config)
  const request = await startModelRequest(messages, payload)
  const completionId = createCompletionId()
  const created = Math.floor(Date.now() / 1000)
  const closeListener = () => request.tokenSource.cancel()

  log(`Streaming OpenAI-compatible request with ${messages.length} prompt messages to ${describeModel(request.model)}`)
  req.on('close', closeListener)
  startSse(res)

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

    writeSseEvent(
      res,
      makeOpenAIStreamChunk(request.model, completionId, created, {}, 'stop')
    )
    writeSseEvent(res, '[DONE]')
    res.end()
  } finally {
    req.off('close', closeListener)
  }
}

function respondWithStreamError(res, error) {
  const message = error instanceof Error ? error.message : String(error)
  writeSseEvent(res, errorBody(message), 'error')
  res.end()
}

function buildConnectionInfo() {
  const config = getConfig()
  return {
    baseUrl: `http://${config.host}:${config.port}/v1`,
    healthUrl: `http://${config.host}:${config.port}/healthz`,
    token: runtimeAuthToken || '(not configured)',
    model: selectedModel ? describeModel(selectedModel) : 'unselected'
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
    `MODEL=${info.model}`
  ].join('\n')

  await vscode.env.clipboard.writeText(text)
  vscode.window.showInformationMessage(`${EXTENSION_NAME} connection info copied to clipboard.`)
}

async function startServer() {
  if (server) {
    vscode.window.showInformationMessage(`${EXTENSION_NAME} server is already running.`)
    return
  }

  await ensureRuntimeAuthToken()
  await selectModelFromUserAction()
  const config = getConfig()

  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${config.host}:${config.port}`)

      if (req.method === 'GET' && url.pathname === '/healthz') {
        jsonResponse(res, 200, {
          ok: true,
          status: 'running',
          model: selectedModelSummary,
          token_configured: Boolean(runtimeAuthToken)
        })
        return
      }

      if (
        req.method === 'GET' &&
        (url.pathname === '/models' || url.pathname === '/v1/models')
      ) {
        const modelInfo = getSelectedModelInfo()
        if (!modelInfo.length) {
          errorResponse(res, 503, 'Model not selected')
          return
        }

        jsonResponse(res, 200, {
          object: 'list',
          data: modelInfo
        })
        return
      }

      if (!isAuthorized(req, runtimeAuthToken)) {
        errorResponse(res, 401, 'Unauthorized', 'authentication_error')
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat') {
        const rawBody = await readRequestBody(req)
        const payload = rawBody ? JSON.parse(rawBody) : {}

        if (payload.stream === true) {
          try {
            await streamBridgeChat(payload, req, res)
          } catch (error) {
            log(`Streaming bridge request failed: ${error instanceof Error ? error.message : String(error)}`)
            if (res.headersSent) {
              respondWithStreamError(res, error)
            } else {
              throw error
            }
          }
          return
        }

        const result = await handleBridgeChat(payload)
        jsonResponse(res, 200, result)
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const rawBody = await readRequestBody(req)
        const payload = rawBody ? JSON.parse(rawBody) : {}

        if (payload.stream === true) {
          try {
            await streamOpenAIChatCompletion(payload, req, res)
          } catch (error) {
            log(
              `Streaming OpenAI-compatible request failed: ${error instanceof Error ? error.message : String(error)}`
            )
            if (res.headersSent) {
              respondWithStreamError(res, error)
            } else {
              throw error
            }
          }
          return
        }

        const result = await handleOpenAIChatCompletion(payload)
        jsonResponse(res, 200, result)
        return
      }

      errorResponse(res, 404, 'Not found')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`Request failed: ${message}`)

      if (error instanceof vscode.LanguageModelError) {
        errorResponse(res, 502, message, 'language_model_error', error.code)
        return
      }

      errorResponse(res, 400, message)
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, resolve)
  })

  log(`${EXTENSION_NAME} listening on http://${config.host}:${config.port}`)
  const action = await vscode.window.showInformationMessage(
    `${EXTENSION_NAME} listening on http://${config.host}:${config.port}`,
    'Copy Token',
    'Copy Connection Info'
  )

  if (action === 'Copy Token') {
    await copyAccessToken()
  } else if (action === 'Copy Connection Info') {
    await copyConnectionInfo()
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
  selectedModelSummary = 'stopped'
  vscode.window.showInformationMessage(`${EXTENSION_NAME} server stopped.`)
}

function showStatus() {
  const info = buildConnectionInfo()
  const state = server ? 'running' : 'stopped'
  vscode.window.showInformationMessage(
    `${EXTENSION_NAME} is ${state} on ${info.baseUrl} using ${info.model}`
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

  context.subscriptions.push(
    vscode.commands.registerCommand('bridgeYourCopilot.startServer', async () => {
      try {
        await startServer()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`Failed to start server: ${message}`)
        vscode.window.showErrorMessage(`${EXTENSION_NAME} failed to start: ${message}`)
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('bridgeYourCopilot.stopServer', async () => {
      try {
        await stopServer()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`Failed to stop server: ${message}`)
        vscode.window.showErrorMessage(`${EXTENSION_NAME} failed to stop: ${message}`)
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('bridgeYourCopilot.showStatus', showStatus)
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('bridgeYourCopilot.selectModel', async () => {
      try {
        const model = await pickModelFromQuickPick()
        if (model) {
          vscode.window.showInformationMessage(`${EXTENSION_NAME} selected model: ${describeModel(model)}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`Failed to select model: ${message}`)
        vscode.window.showErrorMessage(`${EXTENSION_NAME} failed to select model: ${message}`)
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('bridgeYourCopilot.copyAccessToken', async () => {
      try {
        await copyAccessToken()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`Failed to copy access token: ${message}`)
        vscode.window.showErrorMessage(`${EXTENSION_NAME} failed to copy access token: ${message}`)
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('bridgeYourCopilot.copyConnectionInfo', async () => {
      try {
        await copyConnectionInfo()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`Failed to copy connection info: ${message}`)
        vscode.window.showErrorMessage(`${EXTENSION_NAME} failed to copy connection info: ${message}`)
      }
    })
  )
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
