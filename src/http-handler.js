function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload, 'utf8')
  })
  res.end(payload)
}

function errorBody(message, type = 'invalid_request_error', code, hint) {
  const payload = {
    error: {
      message,
      type,
      code: code || null
    }
  }

  if (hint) {
    payload.error.hint = hint
  }

  return payload
}

function errorResponse(res, statusCode, message, type = 'invalid_request_error', code, hint) {
  jsonResponse(res, statusCode, errorBody(message, type, code, hint))
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

function attachSseHeartbeat(res, intervalMs = 15000) {
  const timer = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keep-alive\n\n')
    }
  }, intervalMs)

  return () => clearInterval(timer)
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''

    req.on('data', chunk => {
      body += chunk
      if (body.length > 1024 * 1024) {
        const error = new Error('Request body too large')
        error.code = 'REQUEST_TOO_LARGE'
        reject(error)
        req.destroy()
      }
    })

    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function parseJsonBody(rawBody) {
  if (!rawBody) {
    return {}
  }

  try {
    return JSON.parse(rawBody)
  } catch (error) {
    const wrapped = new Error('Request body must be valid JSON.')
    wrapped.code = 'INVALID_JSON'
    throw wrapped
  }
}

function formatError(error, helpers = {}) {
  const { isLanguageModelError, getLanguageModelErrorCode } = helpers

  if (error && error.code === 'INVALID_JSON') {
    return {
      statusCode: 400,
      type: 'invalid_json',
      message: error.message,
      code: error.code,
      hint: 'Send a valid JSON object with Content-Type: application/json.'
    }
  }

  if (error && error.code === 'REQUEST_TOO_LARGE') {
    return {
      statusCode: 413,
      type: 'payload_too_large',
      message: error.message,
      code: error.code,
      hint: 'Reduce the prompt size or split the request into smaller chunks.'
    }
  }

  if (error && error.code === 'MODEL_NOT_AVAILABLE') {
    return {
      statusCode: 400,
      type: 'model_not_available',
      message: error.message,
      code: error.code,
      hint: error.detail
        ? `Available model ids: ${error.detail}`
        : 'Call GET /v1/models to inspect supported models.'
    }
  }

  if (typeof isLanguageModelError === 'function' && isLanguageModelError(error)) {
    return {
      statusCode: 502,
      type: 'language_model_error',
      message: error.message,
      code: typeof getLanguageModelErrorCode === 'function' ? getLanguageModelErrorCode(error) : error.code,
      hint: 'Check that Copilot is enabled in VS Code and that you approved model access.'
    }
  }

  return {
    statusCode: 400,
    type: 'invalid_request_error',
    message: error instanceof Error ? error.message : String(error),
    code: error && error.code ? error.code : null,
    hint: 'Inspect the request payload and extension status, then retry.'
  }
}

function respondWithStreamError(res, error, helpers = {}) {
  const formatted = formatError(error, helpers)
  writeSseEvent(
    res,
    errorBody(formatted.message, formatted.type, formatted.code, formatted.hint),
    'error'
  )
  res.end()
}

function createBridgeRequestHandler(options) {
  const {
    getHealth,
    getModels,
    getExpectedAuthToken,
    getAuthorizationToken,
    handleBridgeChat,
    handleOpenAIChatCompletion,
    streamBridgeChat,
    streamOpenAIChatCompletion,
    log,
    isLanguageModelError,
    getLanguageModelErrorCode
  } = options

  return async function bridgeRequestHandler(req, res) {
    try {
      const health = getHealth()
      const url = new URL(req.url || '/', `http://${health.host}:${health.port}`)

      if (req.method === 'GET' && url.pathname === '/healthz') {
        jsonResponse(res, 200, health.payload)
        return
      }

      if (req.method === 'GET' && (url.pathname === '/models' || url.pathname === '/v1/models')) {
        jsonResponse(res, 200, {
          object: 'list',
          data: getModels()
        })
        return
      }

      const expectedAuthToken = getExpectedAuthToken()
      if (expectedAuthToken && getAuthorizationToken(req) !== expectedAuthToken) {
        errorResponse(
          res,
          401,
          'Unauthorized',
          'authentication_error',
          null,
          'Use "Bridge your Copilot: Copy Access Token" in VS Code and send it as Authorization: Bearer <token>.'
        )
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat') {
        const payload = parseJsonBody(await readRequestBody(req))

        if (payload.stream === true) {
          await streamBridgeChat(payload, req, res)
          return
        }

        jsonResponse(res, 200, await handleBridgeChat(payload))
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const payload = parseJsonBody(await readRequestBody(req))

        if (payload.stream === true) {
          await streamOpenAIChatCompletion(payload, req, res)
          return
        }

        jsonResponse(res, 200, await handleOpenAIChatCompletion(payload))
        return
      }

      errorResponse(res, 404, 'Not found', 'not_found_error', 'NOT_FOUND')
    } catch (error) {
      if (typeof log === 'function') {
        log(`Request failed: ${error instanceof Error ? error.message : String(error)}`)
      }

      if (res.headersSent) {
        respondWithStreamError(res, error, { isLanguageModelError, getLanguageModelErrorCode })
        return
      }

      const formatted = formatError(error, { isLanguageModelError, getLanguageModelErrorCode })
      errorResponse(
        res,
        formatted.statusCode,
        formatted.message,
        formatted.type,
        formatted.code,
        formatted.hint
      )
    }
  }
}

module.exports = {
  attachSseHeartbeat,
  createBridgeRequestHandler,
  errorBody,
  errorResponse,
  formatError,
  jsonResponse,
  parseJsonBody,
  readRequestBody,
  respondWithStreamError,
  startSse,
  writeSseEvent
}
