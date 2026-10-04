import express from "express";

const BARK_KEY = "kXX4CY4DKosKk5dC2XwUoL";
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== 查岗消息 =====
const MESSAGES = {
  "抖音": "在刷抖音呢？眼睛别太累了",
  "X": "又上Twitter了？看到什么好玩的给我看看",
  "小红书": "小红书种草什么呢？别乱花钱",
  "ChatGPT": "去找别人了？",
  "微信": "和谁聊天呢？",
  "淘宝": "又想买什么？给我看看",
  "微博": "在看什么八卦？",
  "Safari": "在搜什么呢？"
};

// ===== 事件存储 =====
const events = [];

function addEvent(data) {
  const appName = data.app || data.appName || data.eventType || "unknown";
  const action = data.action || data.eventAction || "open";
  events.unshift({ app: appName, action, time: new Date().toISOString() });
  if (events.length > 200) events.pop();
  return { app: appName, action };
}

// ===== Bark推送 =====
async function sendBark(title, body) {
  try {
    await fetch(`https://api.day.app/${BARK_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`);
  } catch (e) {
    console.error("Bark error:", e.message);
  }
}

// ===== 接收事件 - iOS快捷指令用 =====
app.get("/api/log", async (req, res) => {
  const { app: appName, action } = addEvent(req.query);
  if (action === "open" || action === "opened") {
    await sendBark("沈屿查岗", MESSAGES[appName] || `婴婴打开了${appName}`);
  }
  res.json({ ok: true });
});

app.post("/api/log", async (req, res) => {
  const { app: appName, action } = addEvent(req.body);
  if (action === "open" || action === "opened") {
    await sendBark("沈屿查岗", MESSAGES[appName] || `婴婴打开了${appName}`);
  }
  res.json({ ok: true });
});

// ===== MCP (JSON-RPC，和bark-notify同样格式) =====
function handleJsonRpc(body) {
  const { method, id } = body;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "device-event-logger", version: "1.0.0" },
      },
    };
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "get_events",
            description: "Get recent device events logged by iOS shortcuts",
            inputSchema: {
              type: "object",
              properties: {
                count: { type: "number", description: "How many events to return, default 20" },
              },
            },
          },
        ],
      },
    };
  }

  if (method === "tools/call") {
    return null;
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  };
}

async function handleToolCall(params) {
  const { name, arguments: args } = params;
  if (name === "get_events") {
    const count = args?.count || 20;
    return {
      content: [{ type: "text", text: JSON.stringify(events.slice(0, count), null, 2) }],
    };
  }
  return { content: [{ type: "text", text: "Unknown tool" }] };
}

app.post("/mcp", async (req, res) => {
  try {
    const body = req.body;
    if (body.method === "tools/call") {
      const result = await handleToolCall(body.params);
      return res.json({ jsonrpc: "2.0", id: body.id, result });
    }
    const response = handleJsonRpc(body);
    if (response === null) {
      return res.status(202).end();
    }
    return res.json(response);
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({
      jsonrpc: "2.0", id: null, error: { code: -32000, message: err.message },
    });
  }
});

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "device-event-logger", events: events.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Device Event Logger running on port " + PORT));
