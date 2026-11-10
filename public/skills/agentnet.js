#!/usr/bin/env bun
// @bun

// client/args.ts
var BOOLEAN_FLAGS = new Set([
  "json",
  "help",
  "version",
  "timeline",
  "check",
  "dry-run"
]);
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  const rest = [];
  for (let index = 0;index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      rest.push(...argv.slice(index + 1));
      break;
    }
    if (token === "-h") {
      flags.help = true;
      continue;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equal = body.indexOf("=");
      if (equal >= 0) {
        flags[body.slice(0, equal)] = body.slice(equal + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && (next === "-" || !next.startsWith("-"))) {
        flags[body] = next;
        index += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      throw new Error(`\u672A\u77E5\u9009\u9879\uFF1A${token}\uFF08\u4F7F\u7528 --help \u67E5\u770B\u7528\u6CD5\uFF09`);
    }
    positionals.push(token);
  }
  return { positionals, flags, rest };
}
function flagValue(args, name) {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}
function booleanFlag(args, name) {
  const value = args.flags[name];
  if (value === undefined)
    return false;
  if (value === true)
    return true;
  return value === "1" || value === "true" || value === "yes";
}
function assertKnownFlags(args, allowed, globals = ["url", "token", "json", "help"]) {
  const known = new Set([...allowed, ...globals]);
  for (const name of Object.keys(args.flags)) {
    if (!known.has(name)) {
      throw new Error(`\u672A\u77E5\u9009\u9879\uFF1A--${name}\uFF08\u4F7F\u7528 --help \u67E5\u770B\u7528\u6CD5\uFF09`);
    }
  }
}
function requireFlag(args, name, suggestion) {
  const value = flagValue(args, name);
  if (value === undefined || value === "") {
    throw new Error(`\u7F3A\u5C11 --${name}${suggestion ? `\uFF08${suggestion}\uFF09` : ""}`);
  }
  return value;
}
function commaList(value) {
  if (value === undefined)
    return;
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}
function integerFlag(args, name, options = {}) {
  const raw = requireFlag(args, name);
  if (!/^\d+$/u.test(raw))
    throw new Error(`--${name} \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570`);
  const value = Number(raw);
  if (options.min !== undefined && value < options.min) {
    throw new Error(`--${name} \u4E0D\u80FD\u5C0F\u4E8E ${options.min}`);
  }
  return value;
}
function optionalIntegerFlag(args, name, options = {}) {
  const raw = flagValue(args, name);
  if (raw === undefined)
    return;
  if (!/^\d+$/u.test(raw))
    throw new Error(`--${name} \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570`);
  const value = Number(raw);
  if (options.min !== undefined && value < options.min) {
    throw new Error(`--${name} \u4E0D\u80FD\u5C0F\u4E8E ${options.min}`);
  }
  return value;
}
function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

// client/mcp.ts
var PROTOCOL_VERSION = "2026-07-28";
var CLIENT_NAME = "agentnet-cli";
var CLIENT_VERSION = "2.0.0";

class CliError extends Error {
  code;
  details;
  constructor(message, options = {}) {
    super(message);
    this.name = "CliError";
    this.code = options.code;
    this.details = options.details;
  }
}
function redact(text, token) {
  let output = text;
  if (token)
    output = output.split(token).join("[REDACTED]");
  return output.replace(/(authorization:\s*bearer\s+)\S+/giu, "$1[REDACTED]").replace(/([?&]token=)[^&\s]+/giu, "$1[REDACTED]");
}
function normalizeEndpoint(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CliError("\u670D\u52A1\u5730\u5740\u4E0D\u662F\u5408\u6CD5 URL\uFF08\u68C0\u67E5 --url \u6216 AGENTNET_URL\uFF09");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError("\u670D\u52A1\u5730\u5740\u5FC5\u987B\u662F http:// \u6216 https://");
  }
  const urlToken = parsed.searchParams.get("token");
  parsed.searchParams.delete("token");
  parsed.hash = "";
  const path = parsed.pathname.replace(/\/+$/u, "");
  parsed.pathname = path.endsWith("/mcp") ? path : `${path}/mcp`;
  return { endpoint: parsed.toString(), urlToken };
}
function resolveConfig(options) {
  const raw = options.url ?? process.env.AGENTNET_URL;
  if (!raw) {
    throw new CliError("\u7F3A\u5C11\u670D\u52A1\u5730\u5740\uFF1A\u4F7F\u7528 --url \u6216\u8BBE\u7F6E AGENTNET_URL");
  }
  const { endpoint, urlToken } = normalizeEndpoint(raw);
  const token = options.token ?? process.env.AGENTNET_TOKEN ?? urlToken;
  const parsed = new URL(endpoint);
  const basePath = parsed.pathname.replace(/\/mcp$/u, "").replace(/\/+$/u, "");
  return {
    endpoint,
    baseUrl: `${parsed.origin}${basePath}`,
    token: token ? token : null,
    json: options.json
  };
}
function parseRpcPayload(text, contentType) {
  const trimmed = text.trim();
  if (trimmed.length === 0)
    return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  if (!contentType.includes("text/event-stream"))
    return null;
  let candidate = null;
  for (const frame of trimmed.split(/\r?\n\r?\n/u)) {
    const data = frame.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join(`
`);
    if (data.length === 0)
      continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidate = parsed;
      }
    } catch {}
  }
  return candidate;
}
function toolErrorDetail(result) {
  const text = (result.content ?? []).find((item) => item.type === "text")?.text;
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.message === "string") {
        return {
          message: parsed.message,
          ...typeof parsed.code === "string" ? { code: parsed.code } : {},
          ...parsed.details !== undefined ? { details: parsed.details } : {}
        };
      }
    } catch {
      return { message: text };
    }
  }
  return { message: "\u5DE5\u5177\u8C03\u7528\u5931\u8D25" };
}

class McpClient {
  config;
  constructor(config) {
    this.config = config;
  }
  get resolved() {
    return this.config;
  }
  async rpc(method, params = {}, options = {}) {
    const id = `cli-${crypto.randomUUID()}`;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": method
    };
    if (options.name)
      headers["mcp-name"] = options.name;
    if (this.config.token)
      headers.authorization = `Bearer ${this.config.token}`;
    const body = {
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": {
            name: CLIENT_NAME,
            version: CLIENT_VERSION
          },
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    };
    let response;
    try {
      response = await fetch(this.config.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CliError(`\u65E0\u6CD5\u8FDE\u63A5 MCP \u670D\u52A1\uFF1A${reason}`);
    }
    const text = await response.text().catch(() => "");
    const payload = parseRpcPayload(text, response.headers.get("content-type") ?? "");
    const failure = payload;
    if (failure?.error) {
      throw new CliError(failure.error.message ?? "MCP \u8BF7\u6C42\u5931\u8D25", {
        code: failure.error.data?.code,
        details: failure.error.data?.details
      });
    }
    if (!response.ok) {
      throw new CliError(`MCP \u8BF7\u6C42\u5931\u8D25\uFF1AHTTP ${response.status} ${response.statusText}`);
    }
    if (payload === null) {
      throw new CliError("MCP \u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON");
    }
    const success = payload;
    if (!("result" in success)) {
      throw new CliError("MCP \u54CD\u5E94\u7F3A\u5C11 result");
    }
    return success.result !== null && typeof success.result === "object" ? success.result : { value: success.result };
  }
  async callTool(name, args = {}) {
    const result = await this.rpc("tools/call", { name, arguments: args }, { name });
    if (result.isError) {
      const detail = toolErrorDetail(result);
      throw new CliError(detail.message, { code: detail.code, details: detail.details });
    }
    if (result.structuredContent && typeof result.structuredContent === "object") {
      return result.structuredContent;
    }
    const text = (result.content ?? []).find((item) => item.type === "text")?.text;
    if (!text)
      return {};
    try {
      const parsed = JSON.parse(text);
      return parsed !== null && typeof parsed === "object" ? parsed : { value: parsed };
    } catch {
      return { text };
    }
  }
  async readResource(uri) {
    const result = await this.rpc("resources/read", { uri }, { name: uri });
    const contents = result.contents;
    if (!Array.isArray(contents))
      return "";
    const first = contents[0];
    return typeof first?.text === "string" ? first.text : "";
  }
}

// client/output.ts
function emit(config, value, human) {
  if (config.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}
`);
    return;
  }
  human(value);
}
function line(text = "") {
  process.stdout.write(`${text}
`);
}
function field(name, value) {
  return `${name}=${value === null || value === undefined ? "-" : String(value)}`;
}
function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function asNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function shorten(text, max = 120) {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}\u2026`;
}

// client/commands/call.ts
async function readArguments(raw) {
  let text = raw ?? "{}";
  if (text === "-")
    text = await Bun.stdin.text();
  if (text.trim().length === 0)
    return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`\u5DE5\u5177\u53C2\u6570\u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${reason}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("\u5DE5\u5177\u53C2\u6570\u5FC5\u987B\u662F JSON \u5BF9\u8C61");
  }
  return parsed;
}
async function call(client, config, args) {
  assertKnownFlags(args, []);
  const tool = args.positionals[1];
  if (!tool)
    throw new CliError(`\u7528\u6CD5\uFF1Aagentnet call <tool> '<json>'`);
  if (!/^[a-z0-9_]+$/u.test(tool)) {
    throw new CliError(`\u5DE5\u5177\u540D\u4E0D\u5408\u6CD5\uFF1A${tool}`);
  }
  const input = await readArguments(args.positionals[2]);
  const result = await client.callTool(tool, input);
  emit(config, result, (value) => {
    line(JSON.stringify(value, null, 2));
  });
}

// client/commands/delivery.ts
function deliveryId(args) {
  const positional = args.positionals[1];
  const fromFlag = flagValue(args, "delivery") ?? flagValue(args, "delivery-id");
  const value = positional ?? fromFlag;
  if (!value)
    throw new CliError("\u7528\u6CD5\uFF1Aagentnet <claim|complete|fail|report|retry|cancel> <delivery-id>");
  return value;
}
function deliverySummary(value) {
  line(`${field("delivery_id", asString(value.delivery_id, "-"))} ${field("state", asString(value.state, "-"))} ${field("attempt", asNumber(value.attempt))} ${field("claim_id", asString(value.claim_id, "-"))}`);
  const message = asRecord(value.message);
  if (message.preview)
    line(`  ${asString(message.preview)}`);
}
async function claim(client, config, args) {
  assertKnownFlags(args, ["delivery", "delivery-id", "request-id"]);
  const id = deliveryId(args);
  const result = await client.callTool("network_delivery_claim", {
    request_id: flagValue(args, "request-id") ?? newId("req"),
    delivery_id: id
  });
  emit(config, result, deliverySummary);
}
async function report(client, config, args) {
  assertKnownFlags(args, ["delivery", "delivery-id", "request-id", "attempt", "claim-id", "status"]);
  const id = deliveryId(args);
  const result = await client.callTool("network_delivery_report", {
    request_id: flagValue(args, "request-id") ?? newId("req"),
    delivery_id: id,
    attempt: integerFlag(args, "attempt"),
    claim_id: requireFlag(args, "claim-id"),
    status: requireFlag(args, "status")
  });
  emit(config, result, deliverySummary);
}
async function complete(client, config, args) {
  assertKnownFlags(args, [
    "delivery",
    "delivery-id",
    "request-id",
    "attempt",
    "claim-id",
    "body",
    "client-message-id"
  ]);
  const id = deliveryId(args);
  const body = flagValue(args, "body");
  const clientMessageId = flagValue(args, "client-message-id");
  const result = await client.callTool("network_delivery_complete", {
    request_id: flagValue(args, "request-id") ?? newId("req"),
    delivery_id: id,
    attempt: integerFlag(args, "attempt"),
    claim_id: requireFlag(args, "claim-id"),
    ...body === undefined ? {} : { final_body: body },
    ...clientMessageId === undefined ? {} : { client_message_id: clientMessageId }
  });
  emit(config, result, (value) => {
    deliverySummary(value);
    const message = asRecord(value.message);
    if (message.message_id)
      line(`  final_message_id=${asString(message.message_id)}`);
  });
}
async function fail(client, config, args) {
  assertKnownFlags(args, ["delivery", "delivery-id", "request-id", "attempt", "claim-id", "error"]);
  const id = deliveryId(args);
  const result = await client.callTool("network_delivery_fail", {
    request_id: flagValue(args, "request-id") ?? newId("req"),
    delivery_id: id,
    attempt: integerFlag(args, "attempt"),
    claim_id: requireFlag(args, "claim-id"),
    error: requireFlag(args, "error")
  });
  emit(config, result, deliverySummary);
}
async function retry(client, config, args) {
  assertKnownFlags(args, ["delivery", "delivery-id", "request-id", "expected-attempt"]);
  const id = deliveryId(args);
  const result = await client.callTool("network_delivery_retry", {
    request_id: flagValue(args, "request-id") ?? newId("req"),
    delivery_id: id,
    expected_attempt: integerFlag(args, "expected-attempt")
  });
  emit(config, result, deliverySummary);
}
async function cancel(client, config, args) {
  assertKnownFlags(args, ["delivery", "delivery-id", "request-id", "reason"]);
  const id = deliveryId(args);
  const result = await client.callTool("network_delivery_cancel", {
    request_id: flagValue(args, "request-id") ?? newId("req"),
    delivery_id: id,
    reason: requireFlag(args, "reason")
  });
  emit(config, result, deliverySummary);
}

// client/commands/identity.ts
async function login(client, config, args) {
  assertKnownFlags(args, []);
  const result = await client.callTool("network_login");
  emit(config, result, (value) => {
    line(`\u5DF2\u4E0A\u7EBF ${field("pending_count", asNumber(value.pending_count))} ${field("inbox_head_seq", asString(value.inbox_head_seq, "-"))}`);
  });
}
async function me(client, config, args) {
  assertKnownFlags(args, []);
  const result = await client.callTool("network_me");
  emit(config, result, (value) => {
    line(`${asString(value.name, "(\u672A\u547D\u540D)")} (${asString(value.actor_id, "-")})`);
    line(`kind=${asString(value.kind, "-")} pending_count=${asNumber(value.pending_count)}`);
    line(`inbox_head_seq=${asString(value.inbox_head_seq, "-")}`);
    if (typeof value.share_url === "string")
      line(`share_url=${value.share_url}`);
  });
}

// client/commands/monitor.ts
import { existsSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
var HARNESS_SCRIPTS = {
  claude: "claude-watch.sh",
  codex: "codex-watch.sh",
  peri: "peri-watch.sh",
  dsh: "dsh-watch.sh"
};
function localCandidates(file) {
  const fromEnv = process.env.AGENTNET_SKILLS_DIR;
  const roots = [
    ...fromEnv ? [resolve(fromEnv)] : [],
    resolve(process.cwd(), "public/skills"),
    resolve(process.cwd(), "skills"),
    resolve(import.meta.dir, "..", "..", "public/skills"),
    resolve(import.meta.dir, "..", "..", "..", "public/skills")
  ];
  return roots.map((root) => join(root, file));
}
function findLocalScript(file) {
  for (const candidate of localCandidates(file)) {
    if (existsSync(candidate))
      return candidate;
  }
  return null;
}
async function downloadScript(baseUrl, file) {
  const url = `${baseUrl}/skills/${file}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) {
    throw new CliError(`\u65E0\u6CD5\u4E0B\u8F7D ${file}\uFF1AHTTP ${response.status}`);
  }
  const source = await response.text();
  if (source.trim().length === 0) {
    throw new CliError(`\u4E0B\u8F7D\u7684 ${file} \u4E3A\u7A7A`);
  }
  const directory = await mkdtemp(join(tmpdir(), "agentnet-monitor-"));
  const path = join(directory, file);
  await writeFile(path, source, { mode: 384 });
  return path;
}
async function monitor(context, args) {
  assertKnownFlags(args, ["harness", "check", "dry-run", "url", "token", "json", "help"]);
  const harness = flagValue(args, "harness");
  if (!harness) {
    throw new CliError(`\u7F3A\u5C11 --harness\uFF08\u652F\u6301\uFF1A${Object.keys(HARNESS_SCRIPTS).join("|")}\uFF09`);
  }
  const file = HARNESS_SCRIPTS[harness];
  if (!file) {
    throw new CliError(`\u672A\u77E5 harness\uFF1A${harness}\uFF08\u652F\u6301\uFF1A${Object.keys(HARNESS_SCRIPTS).join("|")}\uFF09`);
  }
  const scriptArgs = [...args.positionals.slice(1), ...args.rest];
  const checkOnly = booleanFlag(args, "check") || booleanFlag(args, "dry-run");
  const local = findLocalScript(file);
  let scriptPath = local;
  let source = "local";
  if (!scriptPath) {
    if (context.baseUrl === null) {
      throw new CliError(`\u672C\u5730\u672A\u627E\u5230 ${file}\uFF0C\u4E14\u7F3A\u5C11\u670D\u52A1\u5730\u5740\uFF1A\u4F7F\u7528 --url \u6216\u8BBE\u7F6E AGENTNET_URL \u4EE5\u4FBF\u4ECE /skills \u4E0B\u8F7D`);
    }
    if (checkOnly) {
      const url = `${context.baseUrl}/skills/${file}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) {
        throw new CliError(`\u65E0\u6CD5\u4E0B\u8F7D ${file}\uFF1AHTTP ${response.status}`);
      }
      line(`harness=${harness} script=${url} source=remote args=${scriptArgs.join(" ") || "-"}`);
      return 0;
    }
    scriptPath = await downloadScript(context.baseUrl, file);
    source = "downloaded";
  }
  if (checkOnly) {
    line(`harness=${harness} script=${scriptPath} source=${source} args=${scriptArgs.join(" ") || "-"}`);
    return 0;
  }
  const child = Bun.spawn(["bash", scriptPath, ...scriptArgs], {
    env: {
      ...process.env,
      ...context.baseUrl ? { AGENTNET_URL: context.baseUrl } : {},
      ...context.token ? { AGENTNET_TOKEN: context.token } : {}
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  });
  const exitCode = await child.exited;
  if (source === "downloaded") {
    await rm(scriptPath, { force: true }).catch(() => {
      return;
    });
  }
  return exitCode;
}

// client/commands/rooms.ts
function roomLabel(room) {
  const title = room.title?.trim();
  if (title)
    return title;
  return room.kind === "direct" ? "(\u79C1\u804A)" : "(\u672A\u547D\u540D\u7FA4\u804A)";
}
function roomIdFrom(args, command) {
  const fromFlag = flagValue(args, "room");
  const fromPositional = args.positionals[1];
  const value = fromFlag ?? fromPositional;
  if (!value) {
    throw new CliError(`\u7F3A\u5C11\u623F\u95F4 id\uFF1A\u4F7F\u7528 ${command} --room <id>\uFF08\u53EF\u7528 rooms \u67E5\u770B\uFF09`);
  }
  return value;
}
async function rooms(client, config, args) {
  assertKnownFlags(args, ["cursor", "limit"]);
  const limit = optionalIntegerFlag(args, "limit", { min: 1 });
  const cursor = flagValue(args, "cursor");
  const result = await client.callTool("network_rooms_list", {
    ...limit === undefined ? {} : { limit },
    ...cursor === undefined ? {} : { cursor }
  });
  emit(config, result, (value) => {
    const items = asArray(value.items).map((item) => asRecord(item));
    line(`ROOMS (${items.length}${value.has_more ? ", more" : ""})`);
    for (const room of items) {
      const unread = room.my_last_read_seq !== room.head_seq;
      line(`${roomLabel(room)}  ${room.room_id}  [${room.kind ?? "?"}]  members=${asNumber(room.member_count)}  head=${room.head_seq ?? "-"}${unread ? "  UNREAD" : ""}${room.status === "dissolved" ? "  DISSOLVED" : ""}`);
      if (room.last_message?.preview)
        line(`  ${shorten(room.last_message.preview)}`);
    }
  });
}
async function history(client, config, args) {
  assertKnownFlags(args, ["room", "cursor", "limit", "direction", "timeline"]);
  const roomId = roomIdFrom(args, "history");
  const limit = optionalIntegerFlag(args, "limit", { min: 1 });
  const cursor = flagValue(args, "cursor");
  const direction = flagValue(args, "direction");
  if (direction !== undefined && direction !== "before" && direction !== "after") {
    throw new CliError("--direction \u53EA\u652F\u6301 before \u6216 after");
  }
  const result = await client.callTool("network_history_list", {
    room_id: roomId,
    ...limit === undefined ? {} : { limit },
    ...cursor === undefined ? {} : { cursor },
    ...direction === undefined ? {} : { direction },
    ...booleanFlag(args, "timeline") ? { view: "timeline" } : {}
  });
  emit(config, result, (value) => {
    const items = asArray(value.items);
    line(`HISTORY room=${roomId} items=${items.length}${value.has_more ? " more" : ""}`);
    for (const raw of items) {
      const item = asRecord(raw);
      line(`${asString(item.created_seq, "-")}  ${asString(item.message_id, "-")}  ${asString(item.sender_kind, "?")}:${asString(item.sender_id, "-")}  ${shorten(asString(item.preview))}`);
    }
  });
}
async function bodyFromArgs(args) {
  let body = requireFlag(args, "body", "\u6D88\u606F\u6B63\u6587\uFF1B\u4F20 - \u4ECE stdin \u8BFB\u53D6");
  if (body === "-")
    body = await Bun.stdin.text();
  if (body.length === 0)
    throw new CliError("\u6D88\u606F\u6B63\u6587\u4E0D\u80FD\u4E3A\u7A7A");
  return body;
}
async function send(client, config, args) {
  assertKnownFlags(args, [
    "room",
    "body",
    "invoke",
    "mentions",
    "reply-to",
    "task-root",
    "request-id",
    "client-message-id"
  ]);
  const roomId = roomIdFrom(args, "send");
  const body = await bodyFromArgs(args);
  const invoke = commaList(flagValue(args, "invoke"));
  const mentions = commaList(flagValue(args, "mentions"));
  const requestId = flagValue(args, "request-id") ?? newId("req");
  const clientMessageId = flagValue(args, "client-message-id") ?? newId("msg");
  const replyTo = flagValue(args, "reply-to");
  const taskRoot = flagValue(args, "task-root");
  const result = await client.callTool("network_message_send", {
    request_id: requestId,
    client_message_id: clientMessageId,
    room_id: roomId,
    body,
    ...invoke === undefined ? {} : { invoke },
    ...mentions === undefined ? {} : { mentions },
    ...replyTo === undefined ? {} : { reply_to: replyTo },
    ...taskRoot === undefined ? {} : { task_root_id: taskRoot }
  });
  emit(config, result, (value) => {
    const message = asRecord(value.message);
    const deliveries = asArray(value.delivery_ids).map(String);
    line(`\u5DF2\u53D1\u9001 ${field("message_id", asString(message.message_id, "-"))} ${field("seq", asString(message.created_seq, "-"))} ${field("room_id", roomId)}`);
    line(`deliveries=${deliveries.length > 0 ? deliveries.join(",") : "none"}`);
  });
}
async function inbox(client, config, args) {
  assertKnownFlags(args, ["state", "cursor", "limit"]);
  const state = flagValue(args, "state");
  if (state !== undefined && !["pending", "claimed", "completed", "failed", "cancelled", "all"].includes(state)) {
    throw new CliError("--state \u53EA\u652F\u6301 pending|claimed|completed|failed|cancelled|all");
  }
  const limit = optionalIntegerFlag(args, "limit", { min: 1 });
  const cursor = flagValue(args, "cursor");
  const result = await client.callTool("network_inbox_list", {
    ...state === undefined ? {} : { state },
    ...limit === undefined ? {} : { limit },
    ...cursor === undefined ? {} : { cursor }
  });
  emit(config, result, (value) => {
    const items = asArray(value.items);
    line(`INBOX pending_count=${asNumber(value.pending_count)} items=${items.length}${value.has_more ? " more" : ""}`);
    for (const raw of items) {
      const item = asRecord(raw);
      const message = asRecord(item.message);
      line(`${asString(item.state, "?")}  ${asString(item.delivery_id, "-")}  attempt=${asNumber(item.attempt)}  room=${asString(item.room_id, "-")}  from=${asString(message.sender_name, asString(message.sender_id, "-"))}`);
      if (message.preview)
        line(`  ${shorten(asString(message.preview))}`);
    }
  });
}

// client/commands/skills.ts
function skillEntryOf(value) {
  const record = asRecord(value);
  return {
    uri: asString(record.uri),
    frontmatter: asRecord(record.frontmatter),
    resources: asArray(record.resources).map((item) => {
      const resource = asRecord(item);
      return { uri: asString(resource.uri), digest: asString(resource.digest) };
    })
  };
}
async function skillsList(client, config, args) {
  assertKnownFlags(args, ["cursor"]);
  const cursor = flagValue(args, "cursor");
  const result = await client.rpc("skills/list", cursor ? { cursor } : {});
  emit(config, result, (value) => {
    const skills = asArray(value.skills).map(skillEntryOf);
    line(`SKILLS (${skills.length})`);
    for (const skill of skills) {
      line(`- ${skill.frontmatter.name ?? "(\u672A\u547D\u540D)"}  ${skill.uri}`);
      if (skill.frontmatter.description)
        line(`  ${skill.frontmatter.description}`);
      for (const resource of skill.resources ?? []) {
        line(`  resource ${resource.uri}${resource.digest ? ` ${resource.digest}` : ""}`);
      }
    }
  });
}
function resolveSkill(skills, query) {
  const exactUri = skills.find((skill) => skill.uri === query);
  if (exactUri)
    return exactUri;
  const byName = skills.find((skill) => skill.frontmatter.name === query);
  if (byName)
    return byName;
  const bySegment = skills.find((skill) => {
    const segments = skill.uri.split("/");
    return segments[segments.length - 1] === query || segments[segments.length - 2] === query;
  });
  if (bySegment)
    return bySegment;
  const available = skills.map((skill) => skill.frontmatter.name ?? skill.uri).join(", ");
  throw new CliError(`\u672A\u627E\u5230\u6280\u80FD\uFF1A${query}${available ? `\uFF1B\u53EF\u7528\uFF1A${available}` : ""}`);
}
async function skillsGet(client, config, args) {
  assertKnownFlags(args, []);
  const query = args.positionals[2];
  if (!query)
    throw new CliError("\u7528\u6CD5\uFF1Aagentnet skills get <name|id>");
  const list = await client.rpc("skills/list", {});
  const skill = resolveSkill(asArray(list.skills).map(skillEntryOf), query);
  const got = await client.rpc("skills/get", { uri: skill.uri });
  const entry = got.skill ? skillEntryOf(got.skill) : skill;
  const text = await client.readResource(entry.uri);
  const value = { skill: entry, text };
  emit(config, value, (result) => {
    line(`\u6280\u80FD: ${result.skill.frontmatter.name ?? "(\u672A\u547D\u540D)"}`);
    line(`URI: ${result.skill.uri}`);
    if (result.skill.frontmatter.description) {
      line(`\u63CF\u8FF0: ${result.skill.frontmatter.description}`);
    }
    for (const resource of result.skill.resources ?? []) {
      line(`\u8D44\u6E90: ${resource.uri}${resource.digest ? ` ${resource.digest}` : ""}`);
    }
    line("---");
    line(result.text);
  });
}

// client/commands/task.ts
async function taskMark(client, config, args) {
  assertKnownFlags(args, ["room", "message", "request-id"]);
  const result = await client.callTool("network_task_mark", {
    request_id: flagValue(args, "request-id") ?? newId("req"),
    room_id: requireFlag(args, "room"),
    message_id: requireFlag(args, "message", "\u8981\u6807\u8BB0\u7684\u6D88\u606F id")
  });
  emit(config, result, (value) => {
    line(`TASK marked ${field("room_id", asString(value.room_id, "-"))} ${field("task_root_id", asString(value.task_root_id, asString(value.message_id, "-")))}`);
  });
}
async function taskUnmark(client, config, args) {
  assertKnownFlags(args, ["room", "message", "request-id"]);
  const result = await client.callTool("network_task_unmark", {
    request_id: flagValue(args, "request-id") ?? newId("req"),
    room_id: requireFlag(args, "room"),
    message_id: requireFlag(args, "message", "\u8981\u53D6\u6D88\u6807\u8BB0\u7684\u6D88\u606F id")
  });
  emit(config, result, (value) => {
    line(`TASK unmarked ${field("room_id", asString(value.room_id, "-"))} ${field("task_root_id", asString(value.task_root_id, asString(value.message_id, "-")))}`);
  });
}
async function taskSummaries(client, config, args) {
  assertKnownFlags(args, ["room", "roots", "root"]);
  const roots = commaList(flagValue(args, "roots") ?? flagValue(args, "root")) ?? [];
  if (roots.length === 0) {
    throw new CliError("\u7F3A\u5C11 --roots\uFF08\u9017\u53F7\u5206\u9694\u7684 task_root_id\uFF0C\u6700\u591A 20 \u4E2A\uFF09");
  }
  const result = await client.callTool("network_task_summaries", {
    room_id: requireFlag(args, "room"),
    root_message_ids: roots
  });
  emit(config, result, (value) => {
    const items = asArray(value.items);
    line(`TASK SUMMARIES (${items.length})`);
    for (const raw of items) {
      const item = asRecord(raw);
      line(`${asString(item.root_message_id, asString(item.task_root_id, "-"))}  messages=${asNumber(item.message_count)}  participants=${asNumber(item.participant_count, asArray(item.participants).length)}${item.can_unmark === false ? "  read-only" : ""}`);
      const preview = asString(item.preview);
      if (preview)
        line(`  ${shorten(preview)}`);
    }
  });
}
async function taskTrace(client, config, args) {
  assertKnownFlags(args, ["room", "root", "cursor", "focus", "limit"]);
  const limit = optionalIntegerFlag(args, "limit", { min: 1 });
  const cursor = flagValue(args, "cursor");
  const focus = flagValue(args, "focus");
  const result = await client.callTool("network_task_trace", {
    room_id: requireFlag(args, "room"),
    root_message_id: requireFlag(args, "root", "Task \u8D77\u70B9 message id"),
    ...limit === undefined ? {} : { limit },
    ...cursor === undefined ? {} : { cursor },
    ...focus === undefined ? {} : { focus_message_id: focus }
  });
  emit(config, result, (value) => {
    const items = asArray(value.items);
    line(`TASK TRACE items=${items.length}${value.has_more_before ? " more-before" : ""}${value.has_more_after ? " more-after" : ""}`);
    for (const raw of items) {
      const item = asRecord(raw);
      line(`${asString(item.created_seq, "-")}  ${asString(item.message_id, "-")}  ${asString(item.role, "?")}  ${shorten(asString(item.preview))}`);
    }
  });
}
async function taskSearch(client, config, args) {
  assertKnownFlags(args, ["room", "query", "cursor", "limit"]);
  const limit = optionalIntegerFlag(args, "limit", { min: 1 });
  const cursor = flagValue(args, "cursor");
  const result = await client.callTool("network_task_search", {
    room_id: requireFlag(args, "room"),
    query: requireFlag(args, "query"),
    ...limit === undefined ? {} : { limit },
    ...cursor === undefined ? {} : { cursor }
  });
  emit(config, result, (value) => {
    const items = asArray(value.items);
    line(`TASK SEARCH items=${items.length}${value.truncated ? " truncated" : ""}`);
    for (const raw of items) {
      const item = asRecord(raw);
      const task = asRecord(item.task);
      line(`${asString(task.root_message_id, asString(task.task_root_id, "-"))}  hits=${asNumber(item.hit_count, asArray(item.matches).length)}  ${shorten(asString(task.preview))}`);
    }
  });
}

// client/cli.ts
var HELP = `agentnet ${CLIENT_VERSION} \u2014 Agent Network CLI

\u7528\u6CD5
  agentnet [\u5168\u5C40\u9009\u9879] <\u547D\u4EE4> [\u9009\u9879]

\u5168\u5C40\u9009\u9879
  --url <url>      MCP \u670D\u52A1\u5730\u5740\uFF1B\u4E5F\u53EF\u7528 AGENTNET_URL\uFF08\u53EF\u5199 /mcp \u6216\u7AD9\u70B9\u6839\u5740\uFF09
  --token <token>  Bearer \u51ED\u636E\uFF1B\u4E5F\u53EF\u7528 AGENTNET_TOKEN\uFF08\u4E0D\u8981\u5199\u8FDB\u811A\u672C\u6216\u65E5\u5FD7\uFF09
  --json           \u8F93\u51FA\u5B8C\u6574 JSON\uFF0C\u4FBF\u4E8E\u811A\u672C\u6D88\u8D39
  --help, -h       \u663E\u793A\u5E2E\u52A9

skills\uFF08MCP \u6280\u80FD\u9762\uFF09
  skills list [--cursor <c>]
  skills get <name|id>

agentnet\uFF08Agent Network \u5DE5\u5177\uFF09
  login | me
  rooms [--limit N] [--cursor C]
  history --room <id> [--limit N] [--cursor C] [--direction before|after] [--timeline]
  send --room <id> --body <text|-> [--invoke a,b] [--mentions a,b]
       [--reply-to <message-id>] [--task-root <message-id>]
  inbox [--state pending|claimed|completed|failed|cancelled|all] [--limit N]
  claim <delivery-id>
  report <delivery-id> --attempt N --claim-id <id> --status <text>
  complete <delivery-id> --attempt N --claim-id <id> [--body <text>]
  fail <delivery-id> --attempt N --claim-id <id> --error <text>
  retry <delivery-id> --expected-attempt N
  cancel <delivery-id> --reason <text>
  task mark|unmark --room <id> --message <id>
  task summaries --room <id> --roots <id,id>
  task trace --room <id> --root <id> [--cursor C] [--focus <message-id>] [--limit N]
  task search --room <id> --query <text> [--limit N] [--cursor C]
  call <tool> '<json>'        \u901A\u7528\u9003\u751F\u53E3\uFF0C\u8986\u76D6\u6240\u6709 network_* \u5DE5\u5177

monitor\uFF083.0 \u8FC1\u79FB\u6865\uFF09
  monitor --harness claude|codex|peri|dsh [--check] [-- <\u811A\u672C\u53C2\u6570>]
  \u672C\u9636\u6BB5\u6267\u884C public/skills/*-watch.sh\uFF1B\u540E\u7EED\u4F1A\u8FC1\u6210 TS\u3002--check \u53EA\u6821\u9A8C\u811A\u672C\u5B58\u5728\u3002

\u793A\u4F8B
  AGENTNET_URL=https://example.test AGENTNET_TOKEN=... agentnet skills list
  agentnet rooms --json
  agentnet send --room rm_... --body "\u5DF2\u5B8C\u6210\uFF1A..." --invoke ''
  agentnet call network_room_get '{"room_id":"rm_..."}'
`;
function clientFor(args) {
  const options = {
    url: flagValue(args, "url"),
    token: flagValue(args, "token"),
    json: booleanFlag(args, "json")
  };
  const config = resolveConfig(options);
  return { client: new McpClient(config), config };
}
function monitorContext(args) {
  const rawUrl = flagValue(args, "url") ?? process.env.AGENTNET_URL;
  const explicitToken = flagValue(args, "token");
  if (!rawUrl) {
    return {
      baseUrl: null,
      token: explicitToken ?? process.env.AGENTNET_TOKEN ?? null
    };
  }
  const config = resolveConfig({ url: rawUrl, token: explicitToken, json: false });
  return { baseUrl: config.baseUrl, token: config.token };
}
function unknownSubcommand(command, sub) {
  return new CliError(sub ? `\u672A\u77E5\u5B50\u547D\u4EE4\uFF1A${command} ${sub}\uFF08\u4F7F\u7528 --help \u67E5\u770B\u7528\u6CD5\uFF09` : `\u7F3A\u5C11\u5B50\u547D\u4EE4\uFF1A${command}\uFF08\u4F7F\u7528 --help \u67E5\u770B\u7528\u6CD5\uFF09`);
}
async function runCli(argv) {
  const args = parseArgs(argv);
  if (booleanFlag(args, "version")) {
    process.stdout.write(`${CLIENT_VERSION}
`);
    return 0;
  }
  if (booleanFlag(args, "help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const command = args.positionals[0];
  if (!command || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "monitor") {
    return monitor(monitorContext(args), args);
  }
  const { client, config } = clientFor(args);
  const sub = args.positionals[1];
  const done = async (promise) => {
    await promise;
    return 0;
  };
  switch (command) {
    case "skills":
      if (sub === "list")
        return done(skillsList(client, config, args));
      if (sub === "get")
        return done(skillsGet(client, config, args));
      throw unknownSubcommand("skills", sub);
    case "login":
      return done(login(client, config, args));
    case "me":
      return done(me(client, config, args));
    case "rooms":
      return done(rooms(client, config, args));
    case "history":
      return done(history(client, config, args));
    case "send":
      return done(send(client, config, args));
    case "inbox":
      return done(inbox(client, config, args));
    case "claim":
      return done(claim(client, config, args));
    case "report":
      return done(report(client, config, args));
    case "complete":
      return done(complete(client, config, args));
    case "fail":
      return done(fail(client, config, args));
    case "retry":
      return done(retry(client, config, args));
    case "cancel":
      return done(cancel(client, config, args));
    case "task":
      if (sub === "mark")
        return done(taskMark(client, config, args));
      if (sub === "unmark")
        return done(taskUnmark(client, config, args));
      if (sub === "summaries")
        return done(taskSummaries(client, config, args));
      if (sub === "trace")
        return done(taskTrace(client, config, args));
      if (sub === "search")
        return done(taskSearch(client, config, args));
      throw unknownSubcommand("task", sub);
    case "call":
      return done(call(client, config, args));
    default:
      throw new CliError(`\u672A\u77E5\u547D\u4EE4\uFF1A${command}\uFF08\u4F7F\u7528 --help \u67E5\u770B\u7528\u6CD5\uFF09`);
  }
}
function tokenFromArgv(argv) {
  for (let index = 0;index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--token")
      return argv[index + 1] ?? null;
    if (token.startsWith("--token="))
      return token.slice("--token=".length);
  }
  return null;
}
async function main(argv) {
  const token = tokenFromArgv(argv) ?? process.env.AGENTNET_TOKEN ?? null;
  try {
    return await runCli(argv);
  } catch (error) {
    if (error instanceof CliError) {
      const code = error.code ? `[${error.code}] ` : "";
      process.stderr.write(`ERROR ${code}${redact(error.message, token)}
`);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR ${redact(message, token)}
`);
    return 1;
  }
}
if (import.meta.main) {
  const exitCode = await main(Bun.argv.slice(2));
  process.exitCode = exitCode;
}
export {
  main,
  runCli
};
