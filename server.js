// server.js — JSON-БД + коментарі + приватні userCard + OMDb proxy + аплоуд зображень
require('dotenv').config();

/* ----------------------- fetch polyfill (Render safe) ---------------------- */
const fetchFn = global.fetch
    ? (...args) => global.fetch(...args)
    : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

/* --------------------------------- deps ----------------------------------- */
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { randomUUID } = require("crypto");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const multer = require("multer");
const mime = require("mime-types");

/* --------------------------------- app ------------------------------------ */
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    next();
});
app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()}  ${req.method} ${req.url}`);
    next();
});

/* ------------------------------ storage/dirs ------------------------------ */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

function ensureDb() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    if (!fs.existsSync(DB_PATH)) {
        fs.writeFileSync(
            DB_PATH,
            JSON.stringify({ items: [], meta: { createdAt: new Date().toISOString() } }, null, 2)
        );
    }
}
function readDb() { ensureDb(); return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
function writeDb(db) {
    const t = DB_PATH + ".tmp";
    fs.writeFileSync(t, JSON.stringify(db, null, 2));
    fs.renameSync(t, DB_PATH);
}
function paginate(arr, page = 1, limit = 50) {
    const p = Math.max(1, +page || 1);
    const l = Math.min(200, Math.max(1, +limit || 50));
    const s = (p - 1) * l;
    return { data: arr.slice(s, s + l), page: p, limit: l, total: arr.length };
}

/* -------------------------- static uploads route -------------------------- */
app.use(
    "/uploads",
    express.static(UPLOAD_DIR, {
        setHeaders: (res) =>
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable"),
    })
);

/* ---------------------------------- ajv ----------------------------------- */
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// зручний формат помилок для фронта
function formatAjvErrors(errors = []) {
    return errors.map((e) => {
        // e.instancePath вигляду "/payload/name" або "/title"
        const path = (e.instancePath || "").replace(/^\/+/, "");
        // беремо останній сегмент як ім’я поля
        const field = path.split("/").pop() || (e.params && e.params.missingProperty) || "payload";
        return {
            field,                                 // <- назва поля щоб підсвітити інпут
            message: e.message || "Invalid value", // <- зрозумілий текст
            code: e.keyword || "validation"        // <- тип порушення (minLength, required тощо)
        };
    });
}

const itemSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: { type: "string", format: "uuid" },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
        payload: { type: "object", additionalProperties: true },
    },
    required: ["id", "createdAt", "updatedAt", "payload"],
};
const validateItem = ajv.compile(itemSchema);

const commentPayloadSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        kind: { const: "comment" },
        imdbID: { type: "string", minLength: 2 },
        name: { type: "string", minLength: 2 },
        message: { type: "string", minLength: 2 },
        rating: { type: "integer", minimum: 1, maximum: 5, default: 5 },
        authorToken: { type: "string", minLength: 16 },
    },
    required: ["kind", "imdbID", "name", "message", "authorToken"],
};
const validateCommentPayload = ajv.compile(commentPayloadSchema);

/* ------------------------- userCard (image optional) ---------------------- */
const cardPayloadSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        kind: { const: "userCard" },
        name: { type: "string", minLength: 2 },         // ім’я автора (публічно)
        movieTitle: { type: "string", minLength: 1 },   // назва фільму
        title: { type: "string", minLength: 1 },        // заголовок
        description: { type: "string", minLength: 2 },  // опис
        // imageUrl може бути відсутнім, пустим або null
        imageUrl: { anyOf: [{ type: "string" }, { type: "null" }] },
        isPublic: { type: "boolean", default: false },
        authorToken: { type: "string", minLength: 16 },
    },
    required: ["kind", "name", "movieTitle", "title", "description", "authorToken"],
};
const validateCardPayload = ajv.compile(cardPayloadSchema);

function isAdmin(req) {
    const adminHeader = String(req.headers["x-admin-token"] || "");
    return !!process.env.ADMIN_TOKEN && adminHeader === process.env.ADMIN_TOKEN;
}

/* --------------------------------- misc ----------------------------------- */
app.get("/health", (_req, res) =>
    res.json({ ok: true, time: new Date().toISOString() })
);

/* ------------------------------- comments --------------------------------- */
app.get("/comments", (req, res) => {
    const { imdbID, page, limit } = req.query;
    const token = String(req.headers["x-user-token"] || "");
    const db = readDb();

    let items = db.items.filter((i) => i.payload?.kind === "comment");
    if (imdbID) items = items.filter((i) => i.payload.imdbID === String(imdbID));

    items = items.sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    const paged = paginate(items, page, limit);

    paged.data = paged.data.map((i) => ({
        id: i.id,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        own: !!token && i.payload.authorToken === token,
        payload: {
            kind: "comment",
            imdbID: i.payload.imdbID,
            name: i.payload.name,
            message: i.payload.message,
            rating: i.payload.rating,
        },
    }));

    res.json(paged);
});

app.post("/comments", (req, res) => {
    const token = String(req.headers["x-user-token"] || "");
    if (!token || token.length < 16) {
        return res.status(401).json({
            error: "Missing or invalid x-user-token",
            errors: [{ field: "token", message: "Authorization required", code: "auth" }],
        });
    }
    const base = req.body || {};
    const payload = { kind: "comment", rating: 5, ...base, authorToken: token };

    if (!validateCommentPayload(payload)) {
        return res
            .status(400)
            .json({ error: "Validation failed", errors: formatAjvErrors(validateCommentPayload.errors) });
    }

    const now = new Date().toISOString();
    const item = { id: randomUUID(), createdAt: now, updatedAt: now, payload };

    if (!validateItem(item)) {
        return res
            .status(400)
            .json({ error: "Validation failed", errors: formatAjvErrors(validateItem.errors) });
    }

    const db = readDb();
    db.items.push(item);
    writeDb(db);

    res.status(201).json({
        id: item.id,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        payload: {
            kind: "comment",
            imdbID: payload.imdbID,
            name: payload.name,
            message: payload.message,
            rating: payload.rating,
        },
    });
});

app.patch("/comments/:id", (req, res) => {
    const token = String(req.headers["x-user-token"] || "");
    if (!token || token.length < 16) {
        return res.status(401).json({
            error: "Missing or invalid x-user-token",
            errors: [{ field: "token", message: "Authorization required", code: "auth" }],
        });
    }

    const db = readDb();
    const idx = db.items.findIndex(
        (i) => i.id === req.params.id && i.payload?.kind === "comment"
    );
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    if (db.items[idx].payload.authorToken !== token)
        return res.status(403).json({ error: "Forbidden" });

    const mergedPayload = {
        ...db.items[idx].payload,
        ...(req.body || {}),
        kind: "comment",
        authorToken: token,
    };

    if (!validateCommentPayload(mergedPayload)) {
        return res
            .status(400)
            .json({ error: "Validation failed", errors: formatAjvErrors(validateCommentPayload.errors) });
    }

    const now = new Date().toISOString();
    const merged = { ...db.items[idx], updatedAt: now, payload: mergedPayload };

    if (!validateItem(merged)) {
        return res
            .status(400)
            .json({ error: "Validation failed", errors: formatAjvErrors(validateItem.errors) });
    }

    db.items[idx] = merged;
    writeDb(db);

    res.json({
        id: merged.id,
        createdAt: merged.createdAt,
        updatedAt: merged.updatedAt,
        payload: {
            kind: "comment",
            imdbID: merged.payload.imdbID,
            name: merged.payload.name,
            message: merged.payload.message,
            rating: merged.payload.rating,
        },
    });
});

app.delete("/comments/:id", (req, res) => {
    const token = String(req.headers["x-user-token"] || "");
    if (!token || token.length < 16) {
        return res.status(401).json({
            error: "Missing or invalid x-user-token",
            errors: [{ field: "token", message: "Authorization required", code: "auth" }],
        });
    }

    const db = readDb();
    const idx = db.items.findIndex(
        (i) => i.id === req.params.id && i.payload?.kind === "comment"
    );
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    if (db.items[idx].payload.authorToken !== token)
        return res.status(403).json({ error: "Forbidden" });

    const r = db.items.splice(idx, 1)[0];
    writeDb(db);
    res.json({ ok: true, removedId: r.id });
});

/* ------------------------------- user cards ------------------------------- */
app.get("/cards", (req, res) => {
    const requester = String(req.headers["x-user-token"] || "");
    const admin = isAdmin(req);
    const { page, limit, onlyPublic } = req.query;

    const db = readDb();
    let items = db.items.filter((i) => i.payload?.kind === "userCard");

    if (!admin) {
        if (String(onlyPublic) === "true") {
            items = items.filter((i) => i.payload.isPublic === true);
        } else {
            items = items.filter((i) => i.payload.authorToken === requester);
        }
    }

    items = items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    const paged = paginate(items, page, limit);

    paged.data = paged.data.map((i) => ({
        id: i.id,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        own: !!requester && i.payload.authorToken === requester,
        payload: {
            kind: "userCard",
            name: i.payload.name,
            movieTitle: i.payload.movieTitle,
            title: i.payload.title,
            description: i.payload.description,
            imageUrl: i.payload.imageUrl ?? null,
            isPublic: !!i.payload.isPublic,
        },
    }));

    res.json(paged);
});

app.post("/cards", (req, res) => {
    const requester = String(req.headers["x-user-token"] || "");
    if (!requester || requester.length < 16) {
        return res.status(401).json({
            error: "Missing or invalid x-user-token",
            errors: [{ field: "token", message: "Authorization required", code: "auth" }],
        });
    }

    const base = req.body && typeof req.body === "object" ? req.body : {};
    const payload = {
        kind: "userCard",
        isPublic: false,
        ...base,
        // imageUrl може бути порожнім — тоді не додаємо поле взагалі
        ...(base.imageUrl ? { imageUrl: base.imageUrl } : { imageUrl: null }),
        authorToken: requester,
    };

    if (!validateCardPayload(payload)) {
        return res
            .status(400)
            .json({ error: "Validation failed", errors: formatAjvErrors(validateCardPayload.errors) });
    }

    const now = new Date().toISOString();
    const item = { id: randomUUID(), createdAt: now, updatedAt: now, payload };

    if (!validateItem(item)) {
        return res
            .status(400)
            .json({ error: "Validation failed", errors: formatAjvErrors(validateItem.errors) });
    }

    const db = readDb();
    db.items.push(item);
    writeDb(db);

    res.status(201).json({
        id: item.id,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        payload: {
            kind: "userCard",
            name: payload.name,
            movieTitle: payload.movieTitle,
            title: payload.title,
            description: payload.description,
            imageUrl: payload.imageUrl ?? null,
            isPublic: !!payload.isPublic,
        },
    });
});

app.patch("/cards/:id", (req, res) => {
    const requester = String(req.headers["x-user-token"] || "");
    const admin = isAdmin(req);
    if (!requester && !admin) {
        return res.status(401).json({
            error: "No token",
            errors: [{ field: "token", message: "Authorization required", code: "auth" }],
        });
    }

    const db = readDb();
    const idx = db.items.findIndex(
        (i) => i.id === req.params.id && i.payload?.kind === "userCard"
    );
    if (idx === -1) return res.status(404).json({ error: "Not found" });

    const isOwner = db.items[idx].payload.authorToken === requester;
    if (!isOwner && !admin) return res.status(403).json({ error: "Forbidden" });

    const mergedPayload = {
        ...db.items[idx].payload,
        ...(req.body || {}),
        kind: "userCard",
        authorToken: db.items[idx].payload.authorToken,
    };
    // якщо imageUrl порожній рядок — робимо його null (щоб видалити картинку)
    if (!mergedPayload.imageUrl) mergedPayload.imageUrl = null;

    if (!validateCardPayload(mergedPayload)) {
        return res
            .status(400)
            .json({ error: "Validation failed", errors: formatAjvErrors(validateCardPayload.errors) });
    }

    const now = new Date().toISOString();
    const merged = { ...db.items[idx], updatedAt: now, payload: mergedPayload };

    if (!validateItem(merged)) {
        return res
            .status(400)
            .json({ error: "Validation failed", errors: formatAjvErrors(validateItem.errors) });
    }

    db.items[idx] = merged;
    writeDb(db);

    res.json({
        id: merged.id,
        createdAt: merged.createdAt,
        updatedAt: merged.updatedAt,
        payload: {
            kind: "userCard",
            name: merged.payload.name,
            movieTitle: merged.payload.movieTitle,
            title: merged.payload.title,
            description: merged.payload.description,
            imageUrl: merged.payload.imageUrl ?? null,
            isPublic: !!merged.payload.isPublic,
        },
    });
});

app.delete("/cards/:id", (req, res) => {
    const requester = String(req.headers["x-user-token"] || "");
    const admin = isAdmin(req);
    if (!requester && !admin) {
        return res.status(401).json({
            error: "No token",
            errors: [{ field: "token", message: "Authorization required", code: "auth" }],
        });
    }

    const db = readDb();
    const idx = db.items.findIndex(
        (i) => i.id === req.params.id && i.payload?.kind === "userCard"
    );
    if (idx === -1) return res.status(404).json({ error: "Not found" });

    const isOwner = db.items[idx].payload.authorToken === requester;
    if (!isOwner && !admin) return res.status(403).json({ error: "Forbidden" });

    const removed = db.items.splice(idx, 1)[0];
    writeDb(db);
    res.json({ ok: true, removedId: removed.id });
});

/* ------------------------------ image upload ------------------------------ */
/**
 * Підтримувані типи:
 *   jpg/jpeg/png/webp/gif/bmp/svg + heic/heif/avif/tiff
 * Ліміт розміру — MAX_UPLOAD_MB (за замовчуванням 5 МБ)
 */
const MAX_MB = parseInt(process.env.MAX_UPLOAD_MB || "5", 10);
const ALLOWED_IMAGE_RE = /^image\/(png|jpe?g|webp|gif|bmp|svg\+xml|heic|heif|avif|tiff)$/i;

const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
        filename: (_req, file, cb) => {
            const ext =
                mime.extension(file.mimetype) ||
                path.extname(file.originalname).slice(1) ||
                "bin";
            cb(null, `${randomUUID()}.${ext}`);
        },
    }),
    limits: { fileSize: MAX_MB * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const ok = ALLOWED_IMAGE_RE.test(file.mimetype);
        cb(ok ? null : new Error("Only image files are allowed"));
    },
});

app.post("/upload", upload.single("image"), (req, res) => {
    try {
        if (!req.file)
            return res.status(400).json({
                error: "No file",
                errors: [{ field: "image", message: "File is required", code: "required" }],
            });

        const publicUrl = `/uploads/${req.file.filename}`;
        res.json({
            url: publicUrl,
            size: req.file.size,
            type: req.file.mimetype,
            name: req.file.originalname,
        });
    } catch (err) {
        res.status(400).json({
            error: String(err.message || err),
            errors: [{ field: "image", message: String(err.message || err), code: "upload" }],
        });
    }
});

/* ------------------------------ OMDb proxy ------------------------------- */
app.get("/proxy/omdb", async (req, res) => {
    try {
        const API_KEY = process.env.OMDB_API_KEY;
        if (!API_KEY)
            return res.status(500).json({
                error: "Server missing OMDB_API_KEY",
                errors: [{ field: "server", message: "OMDB_API_KEY is not set", code: "env" }],
            });

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
            if (!q)
                return res.status(400).json({
                    error: "Parameter 'q' is required unless 'i' provided",
                    errors: [{ field: "q", message: "Search query is required", code: "required" }],
                });
            url.searchParams.set("s", q);
            url.searchParams.set("page", String(page));
            if (type) url.searchParams.set("type", type);
            if (y) url.searchParams.set("y", y);
        }

        const r = await fetchFn(url.toString());
        if (!r.ok)
            return res
                .status(r.status)
                .json({ error: `OMDb responded ${r.status}`, errors: [{ field: "omdb", message: `HTTP ${r.status}`, code: "upstream" }] });

        const data = await r.json();
        if (data.Response === "False")
            return res.status(404).json({ error: data.Error || "Not found", errors: [{ field: "q", message: data.Error || "Not found", code: "not_found" }] });

        res.json(data);
    } catch (err) {
        res.status(500).json({
            error: "OMDb proxy error",
            details: String(err),
            errors: [{ field: "server", message: String(err), code: "proxy" }],
        });
    }
});

/* ------------------------------- start app -------------------------------- */
app.listen(PORT, () => {
    ensureDb();
    console.log(`JSON DB API is running on http://localhost:${PORT}`);
});
