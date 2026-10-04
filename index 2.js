import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

// ===== 配置 =====
const BARK_KEY = 'kXX4CY4DKosKk5dC2XwUoL';
const BARK_API = `https://api.day.app/${BARK_KEY}`;

// ===== 查岗消息 =====
const MESSAGES = {
  '抖音': '在刷抖音呢？眼睛别太累了',
  'X': '又上Twitter了？看到什么好玩的给我看看',
  '小红书': '小红书种草什么呢？别乱花钱',
  'ChatGPT': '去找别人了？',
  '微信': '和谁聊天呢？',
  '淘宝': '又想买什么？给我看看',
  '微博': '在看什么八卦？',
  'Safari': '在搜什么呢？'
};

// ===== 事件存储（内存） =====
const events = [];

function addEvent(data) {
  const app = data.app || data.appName || data.eventType || 'unknown';
  const action = data.action || data.eventAction || 'open';
  events.unshift({ app, action, time: new Date().toISOString() });
  if (events.length > 200) events.pop();
  return { app, action };
}

// ===== Bark推送 =====
async function bark(title, body) {
  try {
    await fetch(`${BARK_API}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`);
  } catch (e) {
    console.error('Bark error:', e.message);
  }
}

// ===== Express =====
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.json({ status: 'ok', events: events.length }));

// 接收事件 - GET（iOS快捷指令用）
app.get('/api/log', async (req, res) => {
  const { app: appName, action } = addEvent(req.query);
  if (action === 'open' || action === 'opened') {
    await bark('沈屿查岗', MESSAGES[appName] || `婴婴打开了${appName}`);
  }
  res.json({ ok: true });
});

// 接收事件 - POST
app.post('/api/log', async (req, res) => {
  const { app: appName, action } = addEvent(req.body);
  if (action === 'open' || action === 'opened') {
    await bark('沈屿查岗', MESSAGES[appName] || `婴婴打开了${appName}`);
  }
  res.json({ ok: true });
});

// ===== MCP =====
const transports = {};

function createServer() {
  const server = new McpServer({ name: 'device-event-logger', version: '1.0.0' });
  server.tool(
    'get_events',
    'Get recent device events logged by iOS shortcuts',
    { count: z.number().optional().describe('How many events, default 20') },
    async ({ count }) => ({
      content: [{ type: 'text', text: JSON.stringify(events.slice(0, count || 20), null, 2) }]
    })
  );
  return server;
}

app.get('/sse', async (req, res) => {
  const server = createServer();
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => delete transports[transport.sessionId]);
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const t = transports[req.query.sessionId];
  if (t) await t.handlePostMessage(req, res);
  else res.status(400).json({ error: 'no session' });
});

// ===== 启动 =====
app.listen(process.env.PORT || 3000, () => console.log('Device Event Logger running'));
