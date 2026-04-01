const http = require('http');
const vscode = require('vscode');

let outputChannel;
let server;
let selectedModel;
let selectedModelSummary = 'uninitialized';

function assertLanguageModelApiAvailable() {
  if (
    !vscode.lm ||
    typeof vscode.lm.selectChatModels !== 'function' ||
    !vscode.LanguageModelChatMessage ||
    !vscode.LanguageModelTextPart
  ) {
    throw new Error(
      'This extension requires VS Code 1.91 or newer with the Language Model API available.'
    );
  }
}

function getConfig() {
  const config = vscode.workspace.getConfiguration('copilotBridge');
  return {
    host: config.get('host', '127.0.0.1'),
    port: config.get('port', 8765),
    modelFamily: (config.get('modelFamily', '') || '').trim(),
    defaultInstruction: config.get('defaultInstruction', '') || '',
    authToken: config.get('authToken', '') || ''
  };
}

function log(message) {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload, 'utf8')
  });
  res.end(payload);
}

function errorResponse(res, statusCode, message, type = 'invalid_request_error', code) {
  jsonResponse(res, statusCode, {
    error: {
      message,
      type,
      code: code || null
    }
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function normalizeContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (!part || typeof part !== 'object') {
          return '';
        }

        if (part.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }

        if (typeof part.content === 'string') {
          return part.content;
        }

        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }

  return '';
}

function appendUserInstruction(messages, instruction) {
  const text = typeof instruction === 'string' ? instruction.trim() : '';
  if (text) {
    messages.push(vscode.LanguageModelChatMessage.User(text));
  }
}

function createBridgeMessages(payload, config) {
  const messages = [];

  appendUserInstruction(messages, config.defaultInstruction);
  appendUserInstruction(messages, payload.instruction);

  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    for (const message of payload.messages) {
      const content = normalizeContent(message && message.content);
      if (!content) {
        throw new Error('Each message must include string content');
      }

      if (message.role === 'assistant') {
        messages.push(vscode.LanguageModelChatMessage.Assistant(content));
      } else {
        messages.push(vscode.LanguageModelChatMessage.User(content));
      }
    }
    return messages;
  }

  if (typeof payload.prompt === 'string' && payload.prompt.trim()) {
    messages.push(vscode.LanguageModelChatMessage.User(payload.prompt));
    return messages;
  }

  throw new Error('Request must include either prompt or messages');
}

function createOpenAIChatMessages(payload, config) {
  const messages = [];

  appendUserInstruction(messages, config.defaultInstruction);

  if (typeof payload.instructions === 'string' && payload.instructions.trim()) {
    messages.push(vscode.LanguageModelChatMessage.User(payload.instructions));
  }

  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new Error('OpenAI-compatible requests require a non-empty messages array');
  }

  for (const message of payload.messages) {
    const content = normalizeContent(message && message.content);
    if (!content) {
      continue;
    }

    if (message.role === 'assistant') {
      messages.push(vscode.LanguageModelChatMessage.Assistant(content));
      continue;
    }

    messages.push(vscode.LanguageModelChatMessage.User(content));
  }

  if (messages.length === 0) {
    throw new Error('No supported text content found in messages');
  }

  return messages;
}

function getSelectedModelInfo() {
  if (!selectedModel) {
    return null;
  }

  return {
    id: selectedModel.id,
    object: 'model',
    created: 0,
    owned_by: selectedModel.vendor,
    family: selectedModel.family,
    version: selectedModel.version,
    max_input_tokens: selectedModel.maxInputTokens
  };
}

function getAuthorizationToken(req) {
  const bearer = req.headers.authorization;
  if (typeof bearer === 'string' && bearer.startsWith('Bearer ')) {
    return bearer.slice('Bearer '.length).trim();
  }

  const header = req.headers['x-copilot-bridge-token'];
  if (Array.isArray(header)) {
    return header[0];
  }

  return typeof header === 'string' ? header : '';
}

function isAuthorized(req, expectedToken) {
  if (!expectedToken) {
    return true;
  }

  return getAuthorizationToken(req) === expectedToken;
}

async function selectModelFromUserAction() {
  assertLanguageModelApiAvailable();
  const config = getConfig();
  const selector = { vendor: 'copilot' };

  if (config.modelFamily) {
    selector.family = config.modelFamily;
  }

  log(`Selecting Copilot model with selector ${JSON.stringify(selector)}`);

  const models = await vscode.lm.selectChatModels(selector);
  if (!models.length) {
    throw new Error(
      config.modelFamily
        ? `No Copilot models available for family "${config.modelFamily}"`
        : 'No Copilot models available'
    );
  }

  selectedModel = models[0];
  selectedModelSummary = `${selectedModel.vendor}/${selectedModel.family} (${selectedModel.id})`;
  log(`Selected model ${selectedModelSummary}`);
  return selectedModel;
}

async function ensureModelAvailable() {
  if (selectedModel) {
    return selectedModel;
  }

  throw new Error('No model selected. Run "Copilot Bridge: Start Server" from the Command Palette first.');
}

async function generateText(messages) {
  const model = await ensureModelAvailable();
  const tokenSource = new vscode.CancellationTokenSource();
  const response = await model.sendRequest(messages, {}, tokenSource.token);
  let text = '';

  try {
    for await (const chunk of response.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        text += chunk.value;
      } else if (typeof chunk === 'string') {
        text += chunk;
      }
    }
  } finally {
    tokenSource.dispose();
  }

  return { model, text };
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
  };
}

function makeOpenAIChatCompletion(model, payload, text) {
  const created = Math.floor(Date.now() / 1000);

  return {
    id: `chatcmpl-${Date.now()}`,
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
  };
}

async function handleBridgeChat(payload) {
  const config = getConfig();
  const messages = createBridgeMessages(payload, config);
  log(`Forwarding bridge request with ${messages.length} prompt messages to ${selectedModelSummary}`);
  const { model, text } = await generateText(messages);
  return makeBridgeResponse(model, text);
}

async function handleOpenAIChatCompletion(payload) {
  const config = getConfig();

  if (payload.stream === true) {
    throw new Error('stream=true is not supported yet');
  }

  const messages = createOpenAIChatMessages(payload, config);
  log(`Forwarding OpenAI-compatible request with ${messages.length} prompt messages to ${selectedModelSummary}`);
  const { model, text } = await generateText(messages);
  return makeOpenAIChatCompletion(model, payload, text);
}

async function startServer() {
  if (server) {
    vscode.window.showInformationMessage('Copilot Bridge server is already running.');
    return;
  }

  await selectModelFromUserAction();
  const config = getConfig();

  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${config.host}:${config.port}`);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        jsonResponse(res, 200, {
          ok: true,
          status: 'running',
          model: selectedModelSummary
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const modelInfo = getSelectedModelInfo();
        if (!modelInfo) {
          errorResponse(res, 503, 'Model not selected');
          return;
        }

        jsonResponse(res, 200, {
          object: 'list',
          data: [modelInfo]
        });
        return;
      }

      if (!isAuthorized(req, config.authToken)) {
        errorResponse(res, 401, 'Unauthorized', 'authentication_error');
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat') {
        const rawBody = await readRequestBody(req);
        const payload = rawBody ? JSON.parse(rawBody) : {};
        const result = await handleBridgeChat(payload);
        jsonResponse(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const rawBody = await readRequestBody(req);
        const payload = rawBody ? JSON.parse(rawBody) : {};
        const result = await handleOpenAIChatCompletion(payload);
        jsonResponse(res, 200, result);
        return;
      }

      errorResponse(res, 404, 'Not found');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Request failed: ${message}`);

      if (error instanceof vscode.LanguageModelError) {
        errorResponse(res, 502, message, 'language_model_error', error.code);
        return;
      }

      if (message.includes('stream=true')) {
        errorResponse(res, 400, message, 'unsupported_feature');
        return;
      }

      errorResponse(res, 400, message);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  log(`Copilot Bridge listening on http://${config.host}:${config.port}`);
  vscode.window.showInformationMessage(
    `Copilot Bridge listening on http://${config.host}:${config.port}`
  );
}

async function stopServer() {
  if (!server) {
    vscode.window.showInformationMessage('Copilot Bridge server is not running.');
    return;
  }

  await new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  log('Copilot Bridge server stopped');
  server = undefined;
  selectedModel = undefined;
  selectedModelSummary = 'stopped';
  vscode.window.showInformationMessage('Copilot Bridge server stopped.');
}

function showStatus() {
  const config = getConfig();
  const state = server ? 'running' : 'stopped';
  vscode.window.showInformationMessage(
    `Copilot Bridge is ${state} on http://${config.host}:${config.port} using ${selectedModelSummary}`
  );
}

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('Copilot Bridge');
  context.subscriptions.push(outputChannel);

  if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
    log('Language Model API not available. VS Code 1.91 or newer is required.');
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotBridge.startServer', async () => {
      try {
        await startServer();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Failed to start server: ${message}`);
        vscode.window.showErrorMessage(`Copilot Bridge failed to start: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotBridge.stopServer', async () => {
      try {
        await stopServer();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Failed to stop server: ${message}`);
        vscode.window.showErrorMessage(`Copilot Bridge failed to stop: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotBridge.showStatus', showStatus)
  );
}

async function deactivate() {
  if (server) {
    await stopServer();
  }
}

module.exports = {
  activate,
  deactivate
};
