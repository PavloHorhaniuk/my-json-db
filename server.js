// server.js
// Локальна JSON-БД + REST (items/tasks/comments) + проксі до OMDb + авторство коментарів.
// Авторство: у заголовку 'x-user-token' приходить токен, який зберігається у коментарі як authorToken.
// Редагувати/видаляти може лише власник (з тим самим токеном).

require('dotenv').config(); // ДО інших імпортів


const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { randomUUID } = require("crypto");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    next();
});
app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()}  ${req.method} ${req.url}`);
    next();
});

// --- Storage helpers ---
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

function ensureDb() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_PATH)) {
        const initial = { items: [], meta: { version: 1, createdAt: new Date().toISOString() } };
        fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    }
}
function readDb() {
    ensureDb();
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}
function writeDb(db) {
    const tmp = DB_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_PATH);
}
function paginate(array, page = 1, limit = 50) {
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const start = (p - 1) * l;
    return { data: array.slice(start, start + l), page: p, limit: l, total: array.length };
}

// --- AJV Schemas ---
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const itemSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: { type: "string", format: "uuid" },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
        payload: { type: "object", additionalProperties: true }
    },
    required: ["id", "createdAt", "updatedAt", "payload"]
};
const validateItem = ajv.compile(itemSchema);

const taskPayloadSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        kind: { const: "task" },
        title: { type: "string", minLength: 1 },
        status: { type: "string", enum: ["todo", "in_progress", "done", "blocked"] },
        priority: { type: "integer", minimum: 1, maximum: 5 },
        dueDate: { type: "string" },
        tags: { type: "array", items: { type: "string" }, default: [] },
        notes: { type: "string", default: "" }
    },
    required: ["kind", "title", "status"]
};
const validateTaskPayload = ajv.compile(taskPayloadSchema);

// --- comment payload з авторським токеном ---
const commentPayloadSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        kind: { const: "comment" },
        imdbID: { type: "string", minLength: 2 },
        name: { type: "string", minLength: 2 },
        message: { type: "string", minLength: 2 },
        rating: { type: "integer", minimum: 1, maximum: 5, default: 5 },
        authorToken: { type: "string", minLength: 16 }
    },
    required: ["kind", "imdbID", "name", "message", "authorToken"]
};
const validateCommentPayload = ajv.compile(commentPayloadSchema);

// --- Misc routes ---
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get("/backup", (_req, res) => {
    const db = readDb();
    res.setHeader("Content-Disposition", `attachment; filename=backup-${Date.now()}.json`);
    res.json(db);
});

app.post("/import", (req, res) => {
    const incoming = req.body;
    if (!incoming || typeof incoming !== "object" || !Array.isArray(incoming.items)) {
        return res.status(400).json({ error: "Payload must be an object with 'items' array" });
    }
    for (const it of incoming.items) if (!validateItem(it)) {
        return res.status(400).json({ error: "Item validation failed", details: validateItem.errors });
    }
    const db = { items: incoming.items, meta: { ...(incoming.meta || {}), importedAt: new Date().toISOString() } };
    writeDb(db);
    res.json({ ok: true, total: db.items.length });
});

// --- items CRUD (generic) ---
app.get("/items", (req, res) => {
    const { q, page, limit } = req.query;
    const db = readDb();
    let items = db.items;
    if (q) {
        const needle = String(q).toLowerCase();
        items = items.filter((it) => JSON.stringify(it.payload).toLowerCase().includes(needle));
    }
    items = items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json(paginate(items, page, limit));
});

app.get("/items/:id", (req, res) => {
    const db = readDb();
    const item = db.items.find((i) => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
});

app.post("/items", (req, res) => {
    const now = new Date().toISOString();
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const item = { id: randomUUID(), createdAt: now, updatedAt: now, payload };
    if (!validateItem(item)) return res.status(400).json({ error: "Validation failed", details: validateItem.errors });
    const db = readDb(); db.items.push(item); writeDb(db);
    res.status(201).json(item);
});

app.put("/items/:id", (req, res) => {
    const db = readDb();
    const idx = db.items.findIndex((i) => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    const now = new Date().toISOString();
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const next = { id: db.items[idx].id, createdAt: db.items[idx].createdAt, updatedAt: now, payload };
    if (!validateItem(next)) return res.status(400).json({ error: "Validation failed", details: validateItem.errors });
    db.items[idx] = next; writeDb(db); res.json(next);
});

app.patch("/items/:id", (req, res) => {
    const db = readDb();
    const idx = db.items.findIndex((i) => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    const now = new Date().toISOString();
    const merged = { ...db.items[idx], updatedAt: now, payload: { ...db.items[idx].payload, ...(req.body || {}) } };
    if (!validateItem(merged)) return res.status(400).json({ error: "Validation failed", details: validateItem.errors });
    db.items[idx] = merged; writeDb(db); res.json(merged);
});

app.delete("/items/:id", (req, res) => {
    const db = readDb();
    const idx = db.items.findIndex((i) => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    const removed = db.items.splice(idx, 1)[0]; writeDb(db);
    res.json({ ok: true, removedId: removed.id });
});

// --- tasks (аліас поверх items) ---
app.get("/tasks", (req, res) => {
    const { q, page, limit, status, tag } = req.query;
    const db = readDb();
    let items = db.items.filter((i) => i.payload?.kind === "task");
    if (status) items = items.filter((i) => i.payload.status === String(status));
    if (tag) items = items.filter((i) => Array.isArray(i.payload.tags) && i.payload.tags.includes(String(tag)));
    if (q) {
        const needle = String(q).toLowerCase();
        items = items.filter((it) => {
            const p = it.payload || {};
            return [p.title, p.notes, JSON.stringify(p.tags || [])]
                .filter(Boolean).some((v) => String(v).toLowerCase().includes(needle));
        });
    }
    items = items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json(paginate(items, page, limit));
});

app.post("/tasks", (req, res) => {
    const now = new Date().toISOString();
    const base = req.body && typeof req.body === "object" ? req.body : {};
    const payload = { kind: "task", tags: [], priority: 3, status: "todo", ...base };
    if (!validateTaskPayload(payload)) {
        return res.status(400).json({ error: "Task payload validation failed", details: validateTaskPayload.errors });
    }
    const item = { id: randomUUID(), createdAt: now, updatedAt: now, payload };
    if (!validateItem(item)) return res.status(400).json({ error: "Validation failed", details: validateItem.errors });
    const db = readDb(); db.items.push(item); writeDb(db);
    res.status(201).json(item);
});

app.put("/tasks/:id", (req, res) => {
    const db = readDb();
    const idx = db.items.findIndex((i) => i.id === req.params.id && i.payload?.kind === "task");
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    const now = new Date().toISOString();
    const base = req.body && typeof req.body === "object" ? req.body : {};
    const payload = { kind: "task", tags: [], priority: 3, status: "todo", ...base };
    if (!validateTaskPayload(payload)) {
        return res.status(400).json({ error: "Task payload validation failed", details: validateTaskPayload.errors });
    }
    const next = { id: db.items[idx].id, createdAt: db.items[idx].createdAt, updatedAt: now, payload };
    if (!validateItem(next)) return res.status(400).json({ error: "Validation failed", details: validateItem.errors });
    db.items[idx] = next; writeDb(db); res.json(next);
});

app.patch("/tasks/:id", (req, res) => {
    const db = readDb();
    const idx = db.items.findIndex((i) => i.id === req.params.id && i.payload?.kind === "task");
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    const now = new Date().toISOString();
    const mergedPayload = { ...db.items[idx].payload, ...(req.body || {}), kind: "task" };
    if (!validateTaskPayload(mergedPayload)) {
        return res.status(400).json({ error: "Task payload validation failed", details: validateTaskPayload.errors });
    }
    const merged = { ...db.items[idx], updatedAt: now, payload: mergedPayload };
    if (!validateItem(merged)) return res.status(400).json({ error: "Validation failed", details: validateItem.errors });
    db.items[idx] = merged; writeDb(db); res.json(merged);
});

// --- comments (з авторством через x-user-token) ---
app.get("/comments", (req, res) => {
    const { imdbID, page, limit } = req.query;
    const requesterToken = String(req.headers["x-user-token"] || "");
    const db = readDb();
    let items = db.items.filter((i) => i.payload?.kind === "comment");
    if (imdbID) items = items.filter((i) => i.payload.imdbID === String(imdbID));
    items = items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const paged = paginate(items, page, limit);
    paged.data = paged.data.map((i) => ({
        id: i.id,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        own: requesterToken && i.payload?.authorToken === requesterToken,
        payload: {
            kind: "comment",
            imdbID: i.payload.imdbID,
            name: i.payload.name,
            message: i.payload.message,
            rating: i.payload.rating
        }
    }));
    res.json(paged);
});

app.post("/comments", (req, res) => {
    const requesterToken = String(req.headers["x-user-token"] || "");
    if (!requesterToken || requesterToken.length < 16) {
        return res.status(401).json({ error: "Missing or invalid x-user-token" });
    }
    const base = req.body && typeof req.body === "object" ? req.body : {};
    const payload = { kind: "comment", rating: 5, ...base, authorToken: requesterToken };
    if (!validateCommentPayload(payload)) {
        return res.status(400).json({ error: "Comment validation failed", details: validateCommentPayload.errors });
    }
    const now = new Date().toISOString();
    const item = { id: randomUUID(), createdAt: now, updatedAt: now, payload };
    if (!validateItem(item)) return res.status(400).json({ error: "Validation failed", details: validateItem.errors });
    const db = readDb(); db.items.push(item); writeDb(db);
    res.status(201).json({
        id: item.id, createdAt: item.createdAt, updatedAt: item.updatedAt,
        payload: { kind: "comment", imdbID: payload.imdbID, name: payload.name, message: payload.message, rating: payload.rating }
    });
});

app.patch("/comments/:id", (req, res) => {
    const requesterToken = String(req.headers["x-user-token"] || "");
    if (!requesterToken || requesterToken.length < 16) {
        return res.status(401).json({ error: "Missing or invalid x-user-token" });
    }
    const db = readDb();
    const idx = db.items.findIndex((i) => i.id === req.params.id && i.payload?.kind === "comment");
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    if (db.items[idx].payload.authorToken !== requesterToken) {
        return res.status(403).json({ error: "Forbidden" });
    }
    const mergedPayload = { ...db.items[idx].payload, ...(req.body || {}), kind: "comment", authorToken: requesterToken };
    if (!validateCommentPayload(mergedPayload)) {
        return res.status(400).json({ error: "Comment validation failed", details: validateCommentPayload.errors });
    }
    const now = new Date().toISOString();
    const merged = { ...db.items[idx], updatedAt: now, payload: mergedPayload };
    if (!validateItem(merged)) return res.status(400).json({ error: "Validation failed", details: validateItem.errors });
    db.items[idx] = merged; writeDb(db);
    res.json({
        id: merged.id, createdAt: merged.createdAt, updatedAt: merged.updatedAt,
        payload: { kind: "comment", imdbID: merged.payload.imdbID, name: merged.payload.name, message: merged.payload.message, rating: merged.payload.rating }
    });
});

app.delete("/comments/:id", (req, res) => {
    const requesterToken = String(req.headers["x-user-token"] || "");
    if (!requesterToken || requesterToken.length < 16) {
        return res.status(401).json({ error: "Missing or invalid x-user-token" });
    }
    const db = readDb();
    const idx = db.items.findIndex((i) => i.id === req.params.id && i.payload?.kind === "comment");
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    if (db.items[idx].payload.authorToken !== requesterToken) {
        return res.status(403).json({ error: "Forbidden" });
    }
    const removed = db.items.splice(idx, 1)[0]; writeDb(db);
    res.json({ ok: true, removedId: removed.id });
});

// --- Proxy: OMDb ---
app.get("/proxy/omdb", async (req, res) => {
    try {
        const API_KEY = process.env.OMDB_API_KEY;
        if (!API_KEY) return res.status(500).json({ error: "Server missing OMDB_API_KEY" });

        const q = (req.query.q || "").toString().trim();
        const i = (req.query.i || "").toString().trim();
        const page = parseInt(req.query.page || "1", 10) || 1;
        const type = (req.query.type || "").toString().trim();
        const y = (req.query.y || "").toString().trim();

        const url = new URL("https://www.omdbapi.com/");
        url.searchParams.set("apikey", API_KEY);

        if (i) {
            url.searchParams.set("i", i);
            url.searchParams.set("plot", "full");
        } else {
            if (!q) return res.status(400).json({ error: "Parameter 'q' is required unless 'i' provided" });
            url.searchParams.set("s", q);
            url.searchParams.set("page", String(page));
            if (type) url.searchParams.set("type", type);
            if (y) url.searchParams.set("y", y);
        }

        const r = await fetch(url.toString());
        if (!r.ok) return res.status(r.status).json({ error: `OMDb responded ${r.status}` });
        const data = await r.json();
        if (data.Response === "False") return res.status(404).json({ error: data.Error || "Not found" });

        // Легкий журнал пошуку
        try {
            const db = readDb();
            db.meta = db.meta || {};
            db.meta.omdbSearches = db.meta.omdbSearches || [];
            db.meta.omdbSearches.unshift({
                id: randomUUID(), query: q || null, imdbID: i || null, page,
                count: Array.isArray(data.Search) ? data.Search.length : 1,
                at: new Date().toISOString()
            });
            db.meta.omdbSearches = db.meta.omdbSearches.slice(0, 100);
            writeDb(db);
        } catch (_) { }

        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "OMDb proxy error", details: String(err) });
    }
});

app.listen(PORT, () => {
    ensureDb();
    console.log(`JSON DB API is running on http://localhost:${PORT}`);
});
