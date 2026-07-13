#!/usr/bin/env node
'use strict';

const http = require('http');

const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 0);
const OPENAI_BASE_URL = normalizeBaseUrl(process.env.OPENAI_BASE_URL || '');
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || '').trim();
const REQUEST_WAIT_MS = positiveInt(process.env.CURSOR_BRIDGE_REQUEST_WAIT_MS, 15000);
const DEFAULT_TOKEN_COUNT = 1;

if (!PORT) {
    console.error('[cursor-bridge] SERVER_PORT is required');
    process.exit(2);
}
if (!OPENAI_BASE_URL || !OPENAI_API_KEY || !OPENAI_MODEL) {
    console.error('[cursor-bridge] OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL are required');
    process.exit(2);
}

const pendingRequests = new Map();
const modelDetails = encodeModelDetails(OPENAI_MODEL);
const usableModelsResponse = msg(1, modelDetails);
const defaultModelResponse = msg(1, modelDetails);

function positiveInt(value, fallback) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    return trimmed.replace(/\/+$/, '');
}

function getChatCompletionsUrl(baseUrl) {
    const base = normalizeBaseUrl(baseUrl);
    if (/^https:\/\/ark\.cn-beijing\.volces\.com\/api\/compatible(?:\/v1)?$/i.test(base)) {
        return 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
    }
    if (/\/(?:v1\/)?chat\/completions$/i.test(base)) return base;
    return `${base}/chat/completions`;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function writeJson(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function writeProto(res, payload = Buffer.alloc(0)) {
    res.writeHead(200, { 'content-type': 'application/proto' });
    res.end(payload);
}

function writeText(res, status, text) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(text);
}

function base64UrlJson(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function fakeAccessToken() {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return `${base64UrlJson({ alg: 'none' })}.${base64UrlJson({ exp, sub: 'cursor-bridge' })}.sig`;
}

function varint(value) {
    let current = BigInt(value);
    const out = [];
    while (current >= 128n) {
        out.push(Number((current & 127n) | 128n));
        current >>= 7n;
    }
    out.push(Number(current));
    return Buffer.from(out);
}

function key(fieldNo, wireType) {
    return varint((fieldNo << 3) | wireType);
}

function str(fieldNo, value) {
    const payload = Buffer.from(String(value), 'utf8');
    return Buffer.concat([key(fieldNo, 2), varint(payload.length), payload]);
}

function vint(fieldNo, value) {
    return Buffer.concat([key(fieldNo, 0), varint(value)]);
}

function msg(fieldNo, payload) {
    return Buffer.concat([key(fieldNo, 2), varint(payload.length), payload]);
}

function encodeModelDetails(model) {
    return Buffer.concat([
        str(1, model),
        str(3, model),
        str(4, model),
        str(5, model),
        str(6, model)
    ]);
}

function connectFrame(payload, flags = 0) {
    const header = Buffer.alloc(5);
    header[0] = flags;
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
}

function connectEndFrame() {
    return connectFrame(Buffer.from('{}', 'utf8'), 2);
}

function readVarint(buffer, offset = 0) {
    let result = 0n;
    let shift = 0n;
    let index = offset;
    while (index < buffer.length) {
        const byte = buffer[index++];
        result |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return [result, index];
        shift += 7n;
    }
    return [result, index];
}

function decodeFields(buffer) {
    const fields = [];
    let offset = 0;
    while (offset < buffer.length) {
        const start = offset;
        const [tag, afterTag] = readVarint(buffer, offset);
        offset = afterTag;
        const fieldNo = Number(tag >> 3n);
        const wireType = Number(tag & 7n);
        if (!fieldNo && wireType === 0 && offset >= buffer.length) break;
        if (wireType === 0) {
            const [value, afterValue] = readVarint(buffer, offset);
            offset = afterValue;
            fields.push({ fieldNo, wireType, value });
            continue;
        }
        if (wireType === 2) {
            const [length, afterLength] = readVarint(buffer, offset);
            offset = afterLength;
            const end = offset + Number(length);
            if (end > buffer.length) throw new Error('protobuf length exceeds buffer');
            fields.push({ fieldNo, wireType, value: buffer.slice(offset, end) });
            offset = end;
            continue;
        }
        // This bridge only needs varint and length-delimited fields.
        throw new Error(`unsupported protobuf wire type ${wireType} at ${start}`);
    }
    return fields;
}

function decodeFirstStringField(buffer, fieldNo) {
    for (const field of decodeFields(buffer)) {
        if (field.fieldNo === fieldNo && field.wireType === 2) {
            return field.value.toString('utf8');
        }
    }
    return '';
}

function parseConnectRequestId(body) {
    if (body.length < 5) return '';
    const length = body.readUInt32BE(1);
    if (body.length < 5 + length) return '';
    const payload = body.slice(5, 5 + length);
    return decodeFirstStringField(payload, 1);
}

function looksLikeMessage(buffer) {
    if (!buffer.length) return false;
    try {
        const fields = decodeFields(buffer);
        return fields.length > 0;
    } catch {
        return false;
    }
}

function collectLeafStrings(buffer, out = [], depth = 0) {
    if (depth > 12) return out;
    let fields;
    try {
        fields = decodeFields(buffer);
    } catch {
        const text = buffer.toString('utf8').trim();
        if (isUsefulString(text)) out.push(text);
        return out;
    }
    for (const field of fields) {
        if (field.wireType !== 2) continue;
        const child = field.value;
        if (looksLikeMessage(child)) {
            collectLeafStrings(child, out, depth + 1);
        } else {
            const text = child.toString('utf8').trim();
            if (isUsefulString(text)) out.push(text);
        }
    }
    return out;
}

function isUsefulString(text) {
    if (!text) return false;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return false;
    if (text === OPENAI_MODEL) return false;
    if (/^[\w.-]+\/[\w./:-]+$/.test(text) && text.length < 120) return false;
    return /[\p{L}\p{N}]/u.test(text);
}

function parseBidiAppend(body) {
    const fields = decodeFields(body);
    const dataField = fields.find(field => field.fieldNo === 1 && field.wireType === 2);
    const requestField = fields.find(field => field.fieldNo === 2 && field.wireType === 2);
    const binaryField = fields.find(field => field.fieldNo === 4 && field.wireType === 2);
    const requestId = requestField ? decodeFirstStringField(requestField.value, 1) : '';
    let payload = Buffer.alloc(0);
    if (binaryField) {
        payload = binaryField.value;
    } else if (dataField) {
        const data = dataField.value.toString('utf8');
        payload = /^[0-9a-f]+$/i.test(data) ? Buffer.from(data, 'hex') : Buffer.from(data, 'utf8');
    }
    const strings = collectLeafStrings(payload);
    return { requestId, prompt: strings[0] || '', strings };
}

function getOrCreatePending(requestId) {
    let entry = pendingRequests.get(requestId);
    if (entry) return entry;
    entry = {
        payload: null,
        waiters: []
    };
    pendingRequests.set(requestId, entry);
    return entry;
}

function storePrompt(requestId, prompt) {
    if (!requestId || !prompt) return;
    const entry = getOrCreatePending(requestId);
    entry.payload = { prompt };
    for (const waiter of entry.waiters.splice(0)) waiter(entry.payload);
}

function waitForPrompt(requestId) {
    const entry = getOrCreatePending(requestId);
    if (entry.payload) return Promise.resolve(entry.payload);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const index = entry.waiters.indexOf(onReady);
            if (index >= 0) entry.waiters.splice(index, 1);
            reject(new Error(`timed out waiting for BidiAppend payload for ${requestId}`));
        }, REQUEST_WAIT_MS);
        if (typeof timer.unref === 'function') timer.unref();
        function onReady(payload) {
            clearTimeout(timer);
            resolve(payload);
        }
        entry.waiters.push(onReady);
    });
}

function encodeTextDelta(text) {
    return msg(1, msg(1, str(1, text)));
}

function encodeTurnEnded(usage) {
    const inputTokens = Number(usage && (usage.prompt_tokens || usage.input_tokens || usage.inputTokens)) || DEFAULT_TOKEN_COUNT;
    const outputTokens = Number(usage && (usage.completion_tokens || usage.output_tokens || usage.outputTokens)) || DEFAULT_TOKEN_COUNT;
    return msg(1, msg(14, Buffer.concat([
        vint(1, inputTokens),
        vint(2, outputTokens),
        vint(3, Number(usage && (usage.cache_read_input_tokens || usage.cacheReadTokens)) || 0),
        vint(4, Number(usage && (usage.cache_creation_input_tokens || usage.cacheWriteTokens)) || 0)
    ])));
}

async function callOpenAi(prompt, onText) {
    const response = await fetch(getChatCompletionsUrl(OPENAI_BASE_URL), {
        method: 'POST',
        headers: {
            authorization: `Bearer ${OPENAI_API_KEY}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model: OPENAI_MODEL,
            messages: [{ role: 'user', content: prompt }],
            stream: true,
            stream_options: { include_usage: true }
        })
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`OpenAI request failed: HTTP ${response.status} ${text.slice(0, 1000)}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
        const payload = await response.json();
        const text = payload && payload.choices && payload.choices[0]
            && payload.choices[0].message && payload.choices[0].message.content;
        if (text) onText(String(text));
        return payload && payload.usage ? payload.usage : null;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;
    for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = findSseBoundary(buffer)) !== null) {
            const event = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary.length);
            for (const line of event.split(/\r?\n/)) {
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (!data || data === '[DONE]') continue;
                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch {
                    continue;
                }
                if (parsed.usage) usage = parsed.usage;
                const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
                if (delta && delta.content) onText(String(delta.content));
            }
        }
    }
    return usage;
}

function findSseBoundary(buffer) {
    const match = /\r?\n\r?\n/.exec(buffer);
    return match ? { index: match.index, length: match[0].length } : null;
}

async function handleRunSse(req, res, body) {
    const requestId = parseConnectRequestId(body);
    if (!requestId) {
        writeText(res, 400, 'missing RunSSE request_id');
        return;
    }
    res.writeHead(200, { 'content-type': 'application/connect+proto' });

    let payload;
    try {
        payload = await waitForPrompt(requestId);
    } catch (err) {
        const message = `[cursor-bridge] ${err && err.message ? err.message : String(err)}`;
        console.error(message);
        res.write(connectFrame(Buffer.from(JSON.stringify({
            error: {
                code: 'deadline_exceeded',
                message
            }
        }), 'utf8'), 2));
        res.end();
        return;
    }

    let wroteText = false;
    let usage = null;
    try {
        usage = await callOpenAi(payload.prompt, text => {
            if (!text) return;
            wroteText = true;
            res.write(connectFrame(encodeTextDelta(text)));
        });
        if (!wroteText) {
            res.write(connectFrame(encodeTextDelta('')));
        }
        res.write(connectFrame(encodeTurnEnded(usage)));
        res.write(connectEndFrame());
        res.end();
    } catch (err) {
        const message = `[cursor-bridge] ${err && err.message ? err.message : String(err)}`;
        console.error(message);
        if (!res.headersSent) {
            writeText(res, 502, message);
            return;
        }
        res.write(connectFrame(Buffer.from(JSON.stringify({
            error: {
                code: 'unavailable',
                message
            }
        }), 'utf8'), 2));
        res.end();
    } finally {
        pendingRequests.delete(requestId);
    }
}

async function route(req, res) {
    const body = await readBody(req);
    const url = req.url || '';

    if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
        writeJson(res, 200, { status: 'ok' });
        return;
    }
    if (url === '/auth/exchange_user_api_key') {
        writeJson(res, 200, { accessToken: fakeAccessToken(), refreshToken: 'cursor-bridge-refresh-token' });
        return;
    }
    if (url.includes('AnalyticsService/')) {
        writeJson(res, 200, {});
        return;
    }
    if (url === '/v1/traces') {
        writeProto(res);
        return;
    }
    if (url.includes('/GetUsableModels')) {
        writeProto(res, usableModelsResponse);
        return;
    }
    if (url.includes('/GetDefaultModelForCli')) {
        writeProto(res, defaultModelResponse);
        return;
    }
    if (url.includes('BidiService/BidiAppend')) {
        try {
            const parsed = parseBidiAppend(body);
            storePrompt(parsed.requestId, parsed.prompt);
            writeProto(res);
        } catch (err) {
            writeText(res, 400, err && err.message ? err.message : String(err));
        }
        return;
    }
    if (url.includes('AgentService/RunSSE')) {
        await handleRunSse(req, res, body);
        return;
    }

    // Cursor CLI probes many dashboard/config endpoints during startup. Empty
    // protobuf messages are sufficient for the headless bridge path.
    writeProto(res);
}

const server = http.createServer((req, res) => {
    route(req, res).catch(err => {
        const message = err && err.stack ? err.stack : String(err);
        console.error('[cursor-bridge] unhandled request error', message);
        if (!res.headersSent) writeText(res, 500, message);
        else res.end();
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.error(`[cursor-bridge] listening on 127.0.0.1:${PORT}, model=${OPENAI_MODEL}`);
});
