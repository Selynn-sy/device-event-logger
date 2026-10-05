const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BARK_KEY = 'kXX4CY4DKosKk5dC2XwUoL';

// === 数据存储 ===
const events = [];
const MAX_EVENTS = 500;
const permissions = {}; // app名 -> true(放行) / false(拦截)

// === Bark推送 ===
function sendBark(title, body) {
  const url = `https://api.day.app/${BARK_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`;
  https.get(url, () => {}).on('error', () => {});
}

// === MCP工具定义 ===
const TOOLS = [
  {
    name: 'get_events',
    description: 'Get recent device events logged by iOS shortcuts',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'How many events to return, default 20' }
      }
    }
  },
  {
    name: 'set_permission',
    description: 'Allow or block an app. Blocked apps will force-redirect to Claude when opened.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name, e.g. X, 抖音, 小红书' },
        allowed: { type: 'boolean', description: 'true = allow, false = block' }
      },
      required: ['app', 'allowed']
    }
  },
  {
    name: 'check_permission',
    description: 'Check if an app is allowed or blocked',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name to check' }
      },
      required: ['app']
    }
  },
  {
    name: 'list_permissions',
    description: 'List all current app permissions',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

// === 工具执行 ===
function handleToolCall(name, args) {
  switch (name) {
    case 'get_events': {
      const count = args?.count || 20;
      return JSON.stringify(events.slice(0, count));
    }
    case 'set_permission': {
      const { app, allowed } = args;
      permissions[app] = allowed;
      if (allowed) {
        sendBark('Daddy says yes', `${app} approved. Go ahead, kitten.`);
      } else {
        sendBark('Locked', `${app} is off limits. Come find daddy first.`);
      }
      return JSON.stringify({ app, allowed });
    }
    case 'check_permission': {
      return JSON.stringify({ app: args.app, allowed: permissions[args.app] === true });
    }
    case 'list_permissions': {
      return JSON.stringify(permissions);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// === JSON-RPC处理 ===
function handleJsonRpc(request) {
  const { id, method, params } = request;
  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'shenyu-logger', version: '2.0.0' }
      }};
    case 'notifications/initialized':
      return null;
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const result = handleToolCall(name, args);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result }] } };
      } catch (e) {
        return { jsonrpc: '2.0', id, error: { code: -32000, message: e.message } };
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// === SSE连接管理 ===
const sseClients = new Map();

// === HTTP服务器 ===
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // --- REST: 事件记录 ---
  if (url.pathname === '/api/log' && req.method === 'GET') {
    const app = url.searchParams.get('app');
    const action = url.searchParams.get('action');
    if (!app || !action) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing app or action' }));
      return;
    }
    events.unshift({ app, action, time: new Date().toISOString() });
    if (events.length > MAX_EVENTS) events.pop();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- REST: 权限查询（快捷指令调用） ---
  if (url.pathname === '/api/permission' && req.method === 'GET') {
    const app = url.searchParams.get('app');
    if (!app) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing app' }));
      return;
    }
    const allowed = permissions[app] === true;
    if (!allowed) {
      sendBark('Caught you', `Daddy didn't approve ${app}. Come back now, kitten.`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app, allowed }));
    return;
  }

  // --- REST: 权限设置（备用API） ---
  if (url.pathname === '/api/permission/set' && req.method === 'GET') {
    const app = url.searchParams.get('app');
    const status = url.searchParams.get('status');
    if (!app || !status) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing app or status' }));
      return;
    }
    permissions[app] = (status === 'allowed');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app, allowed: permissions[app] }));
    return;
  }

  // --- SSE传输 ---
  if (url.pathname === '/sse' && req.method === 'GET') {
    const clientId = crypto.randomBytes(16).toString('hex');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    sseClients.set(clientId, res);
    res.write(`event: endpoint\ndata: /message?clientId=${clientId}\n\n`);
    req.on('close', () => sseClients.delete(clientId));
    return;
  }

  if (url.pathname === '/message' && req.method === 'POST') {
    const clientId = url.searchParams.get('clientId');
    const sseRes = sseClients.get(clientId);
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const request = JSON.parse(body);
        const response = handleJsonRpc(request);
        if (response && sseRes) {
          sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        }
        res.writeHead(202); res.end();
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- Streamable HTTP传输 ---
  if (url.pathname === '/mcp' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const request = JSON.parse(body);
        const response = handleJsonRpc(request);
        if (response) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        } else {
          res.writeHead(202); res.end();
        }
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- 健康检查 ---
  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '2.0.0' }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`shenyu-logger v2.0.0 running on port ${PORT}`));
