const { EventEmitter } = require('events')
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createBridgeRequestHandler,
  startSse,
  writeSseEvent
} = require('../src/http-handler')

function makeAuthorizationToken(req) {
  const bearer = req.headers.authorization
  if (typeof bearer === 'string' && bearer.startsWith('Bearer ')) {
    return bearer.slice('Bearer '.length)
  }
  return ''
}

function createMockRequest({ path, method = 'GET', headers = {}, body = '' }) {
  const req = new EventEmitter()
  req.url = path
  req.method = method
  req.headers = headers
  req.destroy = () => {
    req.destroyed = true
  }

  queueMicrotask(() => {
    if (body) {
      req.emit('data', body)
    }
    req.emit('end')
  })

  return req
}

function createMockResponse() {
  let resolveDone
  const done = new Promise(resolve => {
    resolveDone = resolve
  })

  const res = {
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    headers: {},
    chunks: [],
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headers = headers
      this.headersSent = true
    },
    flushHeaders() {},
    write(chunk) {
      this.chunks.push(Buffer.from(String(chunk)))
      this.headersSent = true
    },
    end(chunk) {
      if (chunk) {
        this.write(chunk)
      }
      this.writableEnded = true
      resolveDone()
    }
  }

  return { res, done }
}

function createHandler(overrides = {}) {
  return createBridgeRequestHandler({
    getHealth: () => ({
      host: '127.0.0.1',
      port: 8765,
      payload: {
        ok: true,
        status: 'running',
        model: 'copilot/gpt-5 mini (gpt-5-mini)',
        selected_model_id: 'gpt-5-mini',
        available_model_count: 2,
        token_configured: true
      }
    }),
    getModels: () => [
      { id: 'gpt-5-mini', object: 'model', selected: true },
      { id: 'gpt-4o-mini', object: 'model', selected: false }
    ],
    getExpectedAuthToken: () => 'secret-token',
    getAuthorizationToken: makeAuthorizationToken,
    handleBridgeChat: async payload => ({ content: `bridge:${payload.prompt}` }),
    handleOpenAIChatCompletion: async () => ({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-5-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }),
    streamBridgeChat: async (_payload, _req, res) => {
      startSse(res)
      writeSseEvent(res, { delta: 'hello' }, 'chunk')
      writeSseEvent(res, { done: true }, 'done')
      res.end()
    },
    streamOpenAIChatCompletion: async (_payload, _req, res) => {
      startSse(res)
      writeSseEvent(res, {
        id: 'chatcmpl-stream',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      })
      writeSseEvent(res, {
        id: 'chatcmpl-stream',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }]
      })
      writeSseEvent(res, '[DONE]')
      res.end()
    },
    log: () => {},
    ...overrides
  })
}

async function invoke(handler, requestOptions) {
  const req = createMockRequest(requestOptions)
  const { res, done } = createMockResponse()
  await handler(req, res)
  await done

  return {
    statusCode: res.statusCode,
    headers: res.headers,
    text: Buffer.concat(res.chunks).toString('utf8')
  }
}

test('GET /healthz returns health without auth', async () => {
  const response = await invoke(createHandler(), { path: '/healthz' })
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.text).ok, true)
})

test('GET /v1/models returns the available models without auth', async () => {
  const response = await invoke(createHandler(), { path: '/v1/models' })
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.text).data.length, 2)
})

test('POST /v1/chat rejects missing auth with actionable hint', async () => {
  const response = await invoke(createHandler(), {
    path: '/v1/chat',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'hello' })
  })

  assert.equal(response.statusCode, 401)
  const payload = JSON.parse(response.text)
  assert.match(payload.error.hint, /Copy Access Token/)
})

test('POST /v1/chat accepts valid auth', async () => {
  const response = await invoke(createHandler(), {
    path: '/v1/chat',
    method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'Bearer secret-token'
      },
    body: JSON.stringify({ prompt: 'hello' })
  })

  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.text).content, 'bridge:hello')
})

test('POST /v1/chat returns invalid_json for malformed bodies', async () => {
  const response = await invoke(createHandler(), {
    path: '/v1/chat',
    method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'Bearer secret-token'
      },
    body: '{"prompt":'
  })

  assert.equal(response.statusCode, 400)
  const payload = JSON.parse(response.text)
  assert.equal(payload.error.type, 'invalid_json')
})

test('POST /v1/chat supports SSE streaming', async () => {
  const response = await invoke(createHandler(), {
    path: '/v1/chat',
    method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'Bearer secret-token'
      },
    body: JSON.stringify({ prompt: 'hello', stream: true })
  })

  assert.equal(response.statusCode, 200)
  assert.match(response.headers['Content-Type'] || response.headers['content-type'], /text\/event-stream/)
  assert.match(response.text, /event: chunk/)
  assert.match(response.text, /event: done/)
})

test('POST /v1/chat/completions supports OpenAI-style SSE streaming', async () => {
  const response = await invoke(createHandler(), {
    path: '/v1/chat/completions',
    method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'Bearer secret-token'
      },
    body: JSON.stringify({
      model: 'gpt-5-mini',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }]
    })
  })

  assert.equal(response.statusCode, 200)
  assert.match(response.headers['Content-Type'] || response.headers['content-type'], /text\/event-stream/)
  assert.match(response.text, /chat\.completion\.chunk/)
  assert.match(response.text, /\[DONE\]/)
})
