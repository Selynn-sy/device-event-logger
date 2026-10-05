var http = require('http');
var https = require('https');

var PORT = process.env.PORT || 3000;
var BARK_KEY = 'kXX4CY4DKosKk5dC2XwUoL';

var events = [];
var permissions = {};
var clientCount = 0;
var sseClients = {};

function sendBark(title, body) {
  var url = 'https://api.day.app/' + BARK_KEY + '/' + encodeURIComponent(title) + '/' + encodeURIComponent(body);
  https.get(url, function() {}).on('error', function() {});
}

var TOOLS = [
  { name: 'get_events', description: 'Get recent device events logged by iOS shortcuts', inputSchema: { type: 'object', properties: { count: { type: 'number', description: 'How many events to return, default 20' } } } },
  { name: 'set_permission', description: 'Allow or block an app', inputSchema: { type: 'object', properties: { app: { type: 'string', description: 'App name' }, allowed: { type: 'boolean', description: 'true=allow false=block' } }, required: ['app', 'allowed'] } },
  { name: 'check_permission', description: 'Check if an app is allowed', inputSchema: { type: 'object', properties: { app: { type: 'string', description: 'App name' } }, required: ['app'] } },
  { name: 'list_permissions', description: 'List all permissions', inputSchema: { type: 'object', properties: {} } }
];

function callTool(name, args) {
  if (name === 'get_events') {
    var count = (args && args.count) || 20;
    return JSON.stringify(events.slice(0, count));
  }
  if (name === 'set_permission') {
    permissions[args.app] = args.allowed;
    if (args.allowed) {
      sendBark('Daddy says yes', args.app + ' approved. Go ahead, kitten.');
    } else {
      sendBark('Locked', args.app + ' is off limits. Come find daddy first.');
    }
    return JSON.stringify({ app: args.app, allowed: args.allowed });
  }
  if (name === 'check_permission') {
    return JSON.stringify({ app: args.app, allowed: permissions[args.app] === true });
  }
  if (name === 'list_permissions') {
    return JSON.stringify(permissions);
  }
  return JSON.stringify({ error: 'Unknown tool' });
}

function handleRpc(req) {
  var id = req.id;
  var method = req.method;
  var params = req.params;

  if (method === 'initialize') {
    return { jsonrpc: '2.0', id: id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'shenyu-logger', version: '2.0.0' } } };
  }
  if (method === 'notifications/initialized') {
    return null;
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id: id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    var result = callTool(params.name, params.arguments);
    return { jsonrpc: '2.0', id: id, result: { content: [{ type: 'text', text: result }] } };
  }
  return { jsonrpc: '2.0', id: id, error: { code: -32601, message: 'Method not found' } };
}

function parseUrl(reqUrl) {
  var parts = reqUrl.split('?');
  var pathname = parts[0];
  var params = {};
  if (parts[1]) {
    parts[1].split('&').forEach(function(p) {
      var kv = p.split('=');
      params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    });
  }
  return { pathname: pathname, params: params };
}

var server = http.createServer(function(req, res) {
  var url = parseUrl(req.url);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (url.pathname === '/api/log' && req.method === 'GET') {
    var app = url.params.app;
    var action = url.params.action;
    if (!app || !action) { res.writeHead(400); res.end('Missing params'); return; }
    events.unshift({ app: app, action: action, time: new Date().toISOString() });
    if (events.length > 500) events.pop();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/api/permission' && req.method === 'GET') {
    var app = url.params.app;
    if (!app) { res.writeHead(400); res.end('Missing app'); return; }
    var allowed = permissions[app] === true;
    if (!allowed) {
      sendBark('Caught you', 'Daddy didn\'t approve ' + app + '. Come back now, kitten.');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app: app, allowed: allowed }));
    return;
  }

  if (url.pathname === '/api/permission/set' && req.method === 'GET') {
    var app = url.params.app;
    var status = url.params.status;
    if (!app || !status) { res.writeHead(400); res.end('Missing params'); return; }
    permissions[app] = (status === 'allowed');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app: app, allowed: permissions[app] }));
    return;
  }

  if (url.pathname === '/sse' && req.method === 'GET') {
    clientCount++;
    var clientId = 'c' + clientCount;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    sseClients[clientId] = res;
    res.write('event: endpoint\ndata: /message?clientId=' + clientId + '\n\n');
    req.on('close', function() { delete sseClients[clientId]; });
    return;
  }

  if (url.pathname === '/message' && req.method === 'POST') {
    var clientId = url.params.clientId;
    var sseRes = sseClients[clientId];
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var request = JSON.parse(body);
        var response = handleRpc(request);
        if (response && sseRes) {
          sseRes.write('event: message\ndata: ' + JSON.stringify(response) + '\n\n');
        }
        res.writeHead(202); res.end();
      } catch(e) {
        res.writeHead(400); res.end(e.message);
      }
    });
    return;
  }

  if (url.pathname === '/mcp' && req.method === 'POST') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var request = JSON.parse(body);
        var response = handleRpc(request);
        if (response) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        } else {
          res.writeHead(202); res.end();
        }
      } catch(e) {
        res.writeHead(400); res.end(e.message);
      }
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '2.0.0' }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, function() {
  console.log('shenyu-logger v2.0.0 running on port ' + PORT);
});
