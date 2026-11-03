"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { DatabaseSync } = require("node:sqlite");

const scrypt = promisify(crypto.scrypt);
const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const DATA_DIR = path.resolve(process.env.MYXTECH_DATA_DIR || path.join(__dirname, "data"));

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "myxtech.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'technician')),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS works (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    equip TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('inprogress', 'terminated', 'scheduled', 'priority')),
    "desc" TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
    assignee TEXT NOT NULL DEFAULT '',
    approvedBy TEXT NOT NULL DEFAULT '',
    assetCode TEXT REFERENCES items(code) ON DELETE RESTRICT,
    maintenanceType TEXT NOT NULL DEFAULT 'preventive',
    startedAt TEXT,
    completedAt TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS items (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT NOT NULL,
    date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'maintenance', 'down'))
  );
  CREATE TABLE IF NOT EXISTS warehouse (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    unit TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK (qty >= 0),
    min INTEGER NOT NULL CHECK (min >= 0),
    price INTEGER NOT NULL CHECK (price >= 0)
  );
  CREATE TABLE IF NOT EXISTS materials (
    id TEXT PRIMARY KEY,
    workCode TEXT NOT NULL REFERENCES works(code) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    staff TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK (qty > 0),
    price INTEGER NOT NULL CHECK (price >= 0),
    addedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS materials_work ON materials(workCode);
  CREATE TABLE IF NOT EXISTS work_events (
    id TEXT PRIMARY KEY,
    workCode TEXT NOT NULL REFERENCES works(code) ON DELETE CASCADE,
    eventType TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS work_events_work ON work_events(workCode, createdAt);
  CREATE TABLE IF NOT EXISTS stock_movements (
    id TEXT PRIMARY KEY,
    warehouseCode TEXT NOT NULL REFERENCES warehouse(code) ON DELETE RESTRICT,
    workCode TEXT REFERENCES works(code) ON DELETE SET NULL,
    movementType TEXT NOT NULL,
    delta INTEGER NOT NULL,
    qtyBefore INTEGER NOT NULL,
    qtyAfter INTEGER NOT NULL,
    unitPrice INTEGER NOT NULL,
    note TEXT NOT NULL,
    performedBy TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS stock_movements_item ON stock_movements(warehouseCode, createdAt);
  CREATE INDEX IF NOT EXISTS stock_movements_work ON stock_movements(workCode);
`);

addColumnIfMissing("users", "is_active", "INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))");

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing("works", "assetCode", "TEXT REFERENCES items(code) ON DELETE RESTRICT");
addColumnIfMissing("works", "maintenanceType", "TEXT NOT NULL DEFAULT 'preventive'");
addColumnIfMissing("works", "startedAt", "TEXT");
addColumnIfMissing("works", "completedAt", "TEXT");
addColumnIfMissing("warehouse", "is_active", "INTEGER NOT NULL DEFAULT 1");

const seedWorks = [
  ["002666", "WORK PERMIT - 24M Inspection", "2026-03-04", "AC-0008 - Hệ thống HVAC", "terminated", "Kiểm tra 24 tháng", "normal", "Nguyễn Văn Kỹ Thuật"],
  ["002312", "Monthly Inspection (Kiểm tra tháng)", "2026-03-01", "ACC-0001 - Máy nén khí", "inprogress", "Kiểm tra định kỳ hàng tháng", "normal", "Nguyễn Văn Kỹ Thuật"],
  ["002636", "Regular Inspection 3M", "2026-02-26", "TUR-0004 - Tuabin gió", "scheduled", "Kiểm tra định kỳ 3 tháng", "normal", "Trần Thị B"],
  ["002651", "Change oil (Thay dầu máy)", "2026-02-21", "AC-0009 - Máy nén khí", "scheduled", "Thay dầu", "normal", "Lê Văn C"],
  ["000432", "Boiler 1M Inspection", "2026-02-19", "BO-0000 - Hệ thống nước", "priority", "Kiểm tra lò hơi", "high", "Nguyễn Văn Kỹ Thuật"],
  ["002658", "6M-LUBRICATION AND INSPECTION", "2026-02-19", "SCC-0001 - Băng tải trục vít", "inprogress", "Bôi trơn 6 tháng", "normal", "Trần Thị B"],
];
const insertWork = db.prepare(`INSERT OR IGNORE INTO works
  (code, name, date, equip, status, "desc", priority, assignee)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
for (const work of seedWorks) insertWork.run(...work);

const seedItems = [
  ["AC-0008", "Hệ thống HVAC", "Nhà máy A - Tầng 1", "2023-01-15", "active"],
  ["ACC-0001", "Máy nén khí (Air Compressor)", "Nhà máy A - Khu vực 2", "2022-06-10", "maintenance"],
  ["TUR-0004", "Tuabin gió", "Khu ngoài trời", "2021-11-20", "active"],
  ["AC-0009", "Máy nén khí", "Nhà máy A - Khu vực 3", "2022-08-20", "active"],
  ["BO-0000", "Hệ thống nước (Boiler)", "Nhà máy B - Tầng hầm", "2020-05-01", "down"],
  ["SCC-0001", "Băng tải trục vít", "Nhà máy B - Khu vực 1", "2021-09-10", "maintenance"],
];
const insertItem = db.prepare("INSERT OR IGNORE INTO items (code, name, location, date, status) VALUES (?, ?, ?, ?, ?)");
for (const item of seedItems) insertItem.run(...item);

const seedWarehouse = [
  ["OIL-001", "Dầu máy nén khí (5L)", "Can", 12, 5, 500000],
  ["FLT-089", "Bộ lọc gió", "Cái", 3, 5, 250000],
  ["FLT-090", "Van xả khí", "Cái", 20, 10, 150000],
  ["BLT-005", "Bu lông M8", "Hộp", 50, 20, 50000],
];
const insertWarehouse = db.prepare("INSERT OR IGNORE INTO warehouse (code, name, unit, qty, min, price) VALUES (?, ?, ?, ?, ?, ?)");
for (const item of seedWarehouse) insertWarehouse.run(...item);

const backfillWorkAsset = db.prepare(`UPDATE works SET assetCode = (
  SELECT items.code FROM items
  WHERE works.equip = items.code OR works.equip LIKE items.code || ' - %'
  ORDER BY length(items.code) DESC LIMIT 1
) WHERE assetCode IS NULL`);
backfillWorkAsset.run();

const insertInitialWorkEvent = db.prepare(`INSERT INTO work_events
  (id, workCode, eventType, note, actor)
  SELECT 'initial:' || works.code, works.code, 'created', 'Lệnh bảo trì đã được ghi nhận.', works.assignee
  FROM works WHERE NOT EXISTS (SELECT 1 FROM work_events WHERE workCode=works.code)`);
insertInitialWorkEvent.run();

const seedOpeningMovement = db.prepare(`INSERT INTO stock_movements
  (id, warehouseCode, movementType, delta, qtyBefore, qtyAfter, unitPrice, note, performedBy)
  SELECT lower(hex(randomblob(16))), warehouse.code, 'opening', warehouse.qty, 0,
    warehouse.qty, warehouse.price, 'Tồn đầu kỳ khi khởi tạo sổ kho', 'Hệ thống'
  FROM warehouse
  WHERE NOT EXISTS (
    SELECT 1 FROM stock_movements WHERE warehouseCode=warehouse.code
  )`);
seedOpeningMovement.run();

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(18).toString("base64");
  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "https://wlqyjvagxybuqgfhczgz.supabase.co"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: IS_PRODUCTION ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: "256kb", type: "application/json" }));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.path.startsWith("/api/")) {
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
  next();
});

const cookieName = IS_PRODUCTION ? "__Host-myxtech_session" : "myxtech_session";
const cookieOptions = `Path=/; HttpOnly; SameSite=Strict${IS_PRODUCTION ? "; Secure" : ""}`;

if (IS_PRODUCTION) app.set("trust proxy", 1);

const csrfRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Bạn đã gửi quá nhiều yêu cầu. Vui lòng thử lại sau." },
});
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Bạn đã thử đăng nhập quá nhiều lần. Vui lòng thử lại sau 15 phút." },
});

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

class ValidationError extends Error {}

function setSessionCookie(res, id) {
  res.setHeader("Set-Cookie", `${cookieName}=${id}; ${cookieOptions}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${cookieName}=; ${cookieOptions}; Max-Age=0`);
}

function readCookie(req) {
  const cookies = req.headers.cookie || "";
  const entry = cookies.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
  if (!entry) return null;
  const value = entry.slice(cookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function loadSession(req, res, next) {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  const id = readCookie(req);
  if (!id) {
    req.session = null;
    return next();
  }
  const session = db.prepare(`SELECT sessions.id_hash, sessions.csrf_token, sessions.expires_at,
      users.id, users.email, users.full_name, users.role
    FROM sessions LEFT JOIN users ON users.id = sessions.user_id
    WHERE sessions.id_hash = ? AND sessions.expires_at > ?
      AND (sessions.user_id IS NULL OR users.is_active=1)`).get(hash(id), Date.now());
  if (!session) {
    clearSessionCookie(res);
    req.session = null;
    return next();
  }
  req.sessionId = id;
  req.session = session;
  next();
}

app.use("/api", loadSession);

function requireAuth(req, res, next) {
  if (!req.session || !req.session.id) return sendError(res, 401, "Vui lòng đăng nhập để tiếp tục.");
  next();
}

function requireAdmin(req, res, next) {
  if (req.session?.role !== "admin") return sendError(res, 403, "Bạn không có quyền thực hiện thao tác này.");
  next();
}

function verifySameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (!origin && ["GET", "HEAD"].includes(req.method)) return next();
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    return sendError(res, 403, "Yêu cầu không cùng nguồn.");
  }
  if (!originHost || originHost !== req.get("host")) {
    return sendError(res, 403, "Yêu cầu không cùng nguồn.");
  }
  next();
}

function verifyCsrf(req, res, next) {
  if (!req.session || !constantTimeEqual(req.get("x-csrf-token"), req.session.csrf_token)) {
    return sendError(res, 403, "Phiên bảo mật đã hết hạn. Vui lòng tải lại trang.");
  }
  next();
}

function validateString(value, label, maxLength, { optional = false, multiline = false } = {}) {
  if (optional && (value === undefined || value === "")) return "";
  const controlCharacters = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || controlCharacters.test(value)) {
    throw new ValidationError(`${label} không hợp lệ.`);
  }
  return value.trim();
}

function validateCode(value, label = "Mã") {
  const code = validateString(value, label, 40);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(code)) throw new ValidationError(`${label} không hợp lệ: chỉ được chứa chữ, số, dấu chấm, gạch ngang hoặc gạch dưới.`);
  return code;
}

function validateDate(value) {
  const date = validateString(value, "Ngày", 10);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new ValidationError("Ngày không hợp lệ.");
  }
  return date;
}

function validateEnum(value, allowed, label) {
  if (!allowed.includes(value)) throw new ValidationError(`${label} không hợp lệ.`);
  return value;
}

function validateInteger(value, label, { min = 0, max = 1000000000 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new ValidationError(`${label} không hợp lệ.`);
  return number;
}

function validateWork(body, { allowUnlinked = false } = {}) {
  const assetCode = body.assetCode ? validateCode(body.assetCode, "Mã thiết bị") : "";
  const asset = assetCode
    ? db.prepare("SELECT code, name FROM items WHERE code=?").get(assetCode)
    : null;
  if (assetCode && !asset && !allowUnlinked) throw new ValidationError("Thiết bị không tồn tại.");
  const equip = asset
    ? (() => {
      return `${asset.code} - ${asset.name}`;
    })()
    : validateString(body.equip, "Thiết bị", 160);
  if (!assetCode && !allowUnlinked) throw new ValidationError("Vui lòng liên kết lệnh với một thiết bị.");
  return {
    code: validateCode(body.code, "Mã công việc"),
    name: validateString(body.name, "Tên công việc", 160),
    date: validateDate(body.date),
    equip,
    assetCode: assetCode || null,
    maintenanceType: validateEnum(body.maintenanceType || "preventive", ["preventive", "corrective", "inspection"], "Loại bảo trì"),
    status: validateEnum(body.status, ["inprogress", "terminated", "scheduled", "priority"], "Trạng thái"),
    desc: validateString(body.desc, "Mô tả", 2000, { optional: true, multiline: true }),
    priority: validateEnum(body.priority || "normal", ["normal", "high"], "Mức độ ưu tiên"),
    assignee: validateString(body.assignee || "", "Người phụ trách", 120, { optional: true }),
  };
}

function validateItem(body) {
  return {
    code: validateCode(body.code, "Mã thiết bị"),
    name: validateString(body.name, "Tên thiết bị", 160),
    location: validateString(body.location, "Vị trí", 160),
    date: validateDate(body.date),
    status: validateEnum(body.status, ["active", "maintenance", "down"], "Trạng thái"),
  };
}

function validateWarehouse(body) {
  return {
    code: validateCode(body.code, "Mã vật tư"),
    name: validateString(body.name, "Tên vật tư", 160),
    unit: validateString(body.unit, "Đơn vị tính", 40),
    qty: validateInteger(body.qty, "Số lượng"),
    min: validateInteger(body.min, "Định mức"),
    price: validateInteger(body.price, "Đơn giá"),
  };
}

function validateMaterial(body) {
  return {
    code: validateCode(body.code, "Mã vật tư"),
    qty: validateInteger(body.qty, "Số lượng", { min: 1 }),
  };
}

function validateStockMovement(body) {
  const movementType = validateEnum(body.type, ["receipt", "adjustment"], "Loại giao dịch");
  const quantity = validateInteger(body.quantity, "Số lượng", {
    min: movementType === "receipt" ? 1 : -1000000000,
    max: 1000000000,
  });
  if (movementType === "adjustment" && quantity === 0) {
    throw new ValidationError("Số lượng điều chỉnh phải khác 0.");
  }
  return {
    movementType,
    delta: movementType === "receipt" ? quantity : quantity,
    note: validateString(body.note, "Lý do giao dịch", 300),
  };
}

function addWorkEvent(workCode, eventType, note, actor) {
  db.prepare(`INSERT INTO work_events (id, workCode, eventType, note, actor)
    VALUES (?, ?, ?, ?, ?)`).run(crypto.randomUUID(), workCode, eventType, note, actor || "");
}

function recordStockMovement({ warehouseCode, workCode = null, movementType, delta, note, performedBy }) {
  const item = db.prepare("SELECT qty, price FROM warehouse WHERE code=? AND is_active=1").get(warehouseCode);
  if (!item) throw new ValidationError("Vật tư không tồn tại hoặc đã ngừng sử dụng.");
  const qtyAfter = item.qty + delta;
  if (qtyAfter < 0) throw new RangeError("Tồn kho không đủ cho giao dịch này.");
  db.prepare("UPDATE warehouse SET qty=? WHERE code=?").run(qtyAfter, warehouseCode);
  db.prepare(`INSERT INTO stock_movements
    (id, warehouseCode, workCode, movementType, delta, qtyBefore, qtyAfter, unitPrice, note, performedBy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), warehouseCode, workCode, movementType, delta,
    item.qty, qtyAfter, item.price, note, performedBy || "",
  );
  return { qtyBefore: item.qty, qtyAfter, delta, unitPrice: item.price };
}

function validationRoute(handler) {
  return (req, res, next) => {
    try {
      handler(req, res, next);
    } catch (error) {
      if (error instanceof ValidationError) {
        return sendError(res, 400, error.message);
      }
      next(error);
    }
  };
}

app.get("/api/auth/csrf", csrfRateLimit, (req, res) => {
  if (req.session) return res.json({ csrfToken: req.session.csrf_token });
  const id = crypto.randomBytes(32).toString("hex");
  const csrfToken = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (id_hash, csrf_token, expires_at) VALUES (?, ?, ?)").run(hash(id), csrfToken, Date.now() + SESSION_TTL_MS);
  setSessionCookie(res, id);
  res.json({ csrfToken });
});

app.post("/api/auth/login", loginRateLimit, verifySameOrigin, verifyCsrf, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (email.length > 254) return sendError(res, 401, "Email hoặc mật khẩu không chính xác.");

    const user = db.prepare("SELECT id, email, password_hash, full_name, role FROM users WHERE email = ? AND is_active=1").get(email);
    const [salt, storedHash] = user?.password_hash.split("$") || ["", ""];
    let matches = false;
    if (user && salt && storedHash && password.length <= 256) {
      const derived = await scrypt(password, Buffer.from(salt, "hex"), 64);
      matches = constantTimeEqual(derived.toString("hex"), storedHash);
    } else {
      await scrypt(password.slice(0, 256), Buffer.alloc(16), 64);
    }
    if (!matches) return sendError(res, 401, "Email hoặc mật khẩu không chính xác.");

    db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(req.session.id_hash);
    const id = crypto.randomBytes(32).toString("hex");
    const csrfToken = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (id_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)").run(hash(id), user.id, csrfToken, Date.now() + SESSION_TTL_MS);
    setSessionCookie(res, id);
    res.json({
      user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role },
      csrfToken,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/password", loginRateLimit, verifySameOrigin, verifyCsrf, requireAuth, async (req, res, next) => {
  try {
    const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
    const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
    if (newPassword.length < 12 || newPassword.length > 256) {
      return sendError(res, 400, "Mật khẩu mới phải có từ 12 đến 256 ký tự.");
    }
    if (currentPassword === newPassword) return sendError(res, 400, "Mật khẩu mới phải khác mật khẩu hiện tại.");
    const user = db.prepare("SELECT password_hash FROM users WHERE id=? AND is_active=1").get(req.session.id);
    if (!user) return sendError(res, 401, "Tài khoản không còn hoạt động.");
    const [saltHex, storedHash] = user.password_hash.split("$");
    const currentHash = await scrypt(currentPassword.slice(0, 256), Buffer.from(saltHex, "hex"), 64);
    if (!constantTimeEqual(currentHash.toString("hex"), storedHash)) {
      return sendError(res, 403, "Mật khẩu hiện tại không chính xác.");
    }
    const salt = crypto.randomBytes(16);
    const newHash = await scrypt(newPassword, salt, 64);
    db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
      `${salt.toString("hex")}$${newHash.toString("hex")}`,
      req.session.id,
    );
    db.prepare("DELETE FROM sessions WHERE user_id=? AND id_hash<>?").run(req.session.id, hash(req.sessionId));
    res.json({ changed: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ id: req.session.id, email: req.session.email, full_name: req.session.full_name, role: req.session.role });
});

app.post("/api/auth/logout", verifySameOrigin, verifyCsrf, requireAuth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(req.session.id_hash);
  clearSessionCookie(res);
  res.status(204).end();
});

const api = express.Router();
api.use(requireAuth);
api.get("/users", requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT id, email, full_name, role, is_active, created_at
    FROM users ORDER BY full_name COLLATE NOCASE, email`).all());
});
api.post("/users", requireAdmin, async (req, res, next) => {
  try {
    const email = validateString(req.body?.email, "Email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("Email không hợp lệ.");
    const fullName = validateString(req.body?.full_name, "Họ tên", 120);
    const role = validateEnum(req.body?.role, ["admin", "technician"], "Vai trò");
    const password = req.body?.password;
    if (typeof password !== "string" || password.length < 12 || password.length > 256) {
      throw new ValidationError("Mật khẩu phải có từ 12 đến 256 ký tự.");
    }
    const salt = crypto.randomBytes(16);
    const derived = await scrypt(password, salt, 64);
    const result = db.prepare(`INSERT INTO users (email, password_hash, full_name, role)
      VALUES (?, ?, ?, ?)`).run(email, `${salt.toString("hex")}$${derived.toString("hex")}`, fullName, role);
    res.status(201).json(db.prepare(`SELECT id, email, full_name, role, is_active, created_at
      FROM users WHERE id=?`).get(Number(result.lastInsertRowid)));
  } catch (error) {
    if (error instanceof ValidationError) return sendError(res, 400, error.message);
    if (error?.code === "SQLITE_CONSTRAINT_UNIQUE" || error?.message?.includes("UNIQUE constraint failed")) {
      return sendError(res, 409, "Email này đã có tài khoản.");
    }
    next(error);
  }
});
api.patch("/users/:id/status", requireAdmin, validationRoute((req, res) => {
  const userId = validateInteger(req.params.id, "Tài khoản", { min: 1 });
  if (typeof req.body?.is_active !== "boolean") throw new ValidationError("Trạng thái tài khoản không hợp lệ.");
  const user = db.prepare("SELECT id, role, is_active FROM users WHERE id=?").get(userId);
  if (!user) return sendError(res, 404, "Không tìm thấy tài khoản.");
  if (!req.body.is_active && userId === req.session.id) return sendError(res, 409, "Bạn không thể tự vô hiệu hóa tài khoản đang đăng nhập.");
  if (!req.body.is_active && user.role === "admin") {
    const admins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND is_active=1").get().count;
    if (admins <= 1) return sendError(res, 409, "Không thể vô hiệu hóa quản trị viên cuối cùng.");
  }
  db.prepare("UPDATE users SET is_active=? WHERE id=?").run(req.body.is_active ? 1 : 0, userId);
  if (!req.body.is_active) db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
  res.json({ id: user.id, is_active: req.body.is_active ? 1 : 0 });
}));
const workFields = `code, name, date, equip, status, "desc", priority, assignee, approvedBy,
  assetCode, maintenanceType, startedAt, completedAt, createdAt, updatedAt`;

api.get("/works", (req, res) => res.json(db.prepare(`SELECT ${workFields} FROM works ORDER BY date DESC, code`).all()));
api.get("/works/:code", (req, res) => {
  const work = db.prepare(`SELECT ${workFields} FROM works WHERE code=?`).get(req.params.code);
  if (!work) return sendError(res, 404, "Không tìm thấy công việc.");
  res.json(work);
});
api.get("/works/:code/events", (req, res) => {
  if (!db.prepare("SELECT 1 FROM works WHERE code=?").get(req.params.code)) return sendError(res, 404, "Không tìm thấy công việc.");
  res.json(db.prepare(`SELECT id, eventType, note, actor, createdAt FROM work_events
    WHERE workCode=? ORDER BY createdAt DESC, rowid DESC`).all(req.params.code));
});
api.post("/works/:code/events", validationRoute((req, res) => {
  const work = db.prepare("SELECT status, approvedBy FROM works WHERE code=?").get(req.params.code);
  if (!work) return sendError(res, 404, "Không tìm thấy công việc.");
  if (work.status === "terminated" || work.approvedBy) return sendError(res, 409, "Lệnh đã hoàn tất, không thể thêm ghi chú.");
  const note = validateString(req.body?.note, "Ghi chú", 2000, { multiline: true });
  addWorkEvent(req.params.code, "note", note, req.session.full_name);
  res.status(201).json({ note });
}));
api.post("/works", validationRoute((req, res) => {
  const work = validateWork(req.body || {});
  work.status = "scheduled";
  work.assignee = work.assignee || req.session.full_name;
  const result = db.prepare(`INSERT INTO works
    (code, name, date, equip, status, "desc", priority, assignee, assetCode, maintenanceType)
    VALUES (@code, @name, @date, @equip, @status, @desc, @priority, @assignee, @assetCode, @maintenanceType)`).run(work);
  if (!result.changes) return sendError(res, 409, "Không thể tạo công việc.");
  addWorkEvent(work.code, "created", "Lệnh bảo trì được tạo và lên lịch.", req.session.full_name);
  res.status(201).json(db.prepare(`SELECT ${workFields} FROM works WHERE code=?`).get(work.code));
}));
api.put("/works/:code", validationRoute((req, res) => {
  const work = validateWork({ ...req.body, code: req.params.code });
  const current = db.prepare("SELECT status, approvedBy, assetCode FROM works WHERE code=?").get(work.code);
  if (!current) return sendError(res, 404, "Không tìm thấy công việc.");
  if (current.approvedBy || current.status === "terminated") return sendError(res, 409, "Lệnh đã hoàn tất, không thể chỉnh sửa.");
  if (current.status === "inprogress" && work.assetCode !== current.assetCode) {
    return sendError(res, 409, "Không thể đổi thiết bị sau khi đã bắt đầu lệnh.");
  }
  const result = db.prepare(`UPDATE works SET name=@name, date=@date, equip=@equip, "desc"=@desc,
    priority=@priority, assignee=@assignee, assetCode=@assetCode, maintenanceType=@maintenanceType,
    updatedAt=datetime('now') WHERE code=@code`).run(work);
  if (!result.changes) return sendError(res, 404, "Không tìm thấy công việc.");
  addWorkEvent(work.code, "updated", "Thông tin lệnh bảo trì được cập nhật.", req.session.full_name);
  res.json(db.prepare(`SELECT ${workFields} FROM works WHERE code=?`).get(work.code));
}));
api.post("/works/:code/start", (req, res) => {
  const work = db.prepare(`SELECT code, status, assetCode, maintenanceType, approvedBy FROM works WHERE code=?`).get(req.params.code);
  if (!work) return sendError(res, 404, "Không tìm thấy công việc.");
  if (work.status !== "scheduled" && work.status !== "priority") return sendError(res, 409, "Chỉ có thể bắt đầu lệnh đang được lên lịch.");
  if (!work.assetCode) return sendError(res, 409, "Lệnh chưa được liên kết với thiết bị.");
  db.exec("BEGIN IMMEDIATE");
  try {
    const activeWork = db.prepare(`SELECT code FROM works WHERE assetCode=? AND status='inprogress' AND code<>?`).get(work.assetCode, work.code);
    if (activeWork) {
      db.exec("ROLLBACK");
      return sendError(res, 409, `Thiết bị đang được xử lý trong lệnh ${activeWork.code}.`);
    }
    db.prepare(`UPDATE works SET status='inprogress', startedAt=COALESCE(startedAt, datetime('now')),
      updatedAt=datetime('now') WHERE code=?`).run(work.code);
    db.prepare(`UPDATE items SET status='maintenance' WHERE code=? AND status='active'`).run(work.assetCode);
    addWorkEvent(work.code, "started", "Bắt đầu thực hiện công việc.", req.session.full_name);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  res.json(db.prepare(`SELECT ${workFields} FROM works WHERE code=?`).get(work.code));
});
api.post("/works/:code/complete", (req, res) => {
  const work = db.prepare(`SELECT code, status, assetCode, maintenanceType, approvedBy FROM works WHERE code=?`).get(req.params.code);
  if (!work) return sendError(res, 404, "Không tìm thấy công việc.");
  if (work.status !== "inprogress") return sendError(res, 409, "Chỉ có thể hoàn thành lệnh đang thực hiện.");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE works SET status='terminated', completedAt=datetime('now'), updatedAt=datetime('now')
      WHERE code=?`).run(work.code);
    if (work.assetCode) {
      const anotherActiveWork = db.prepare(`SELECT 1 FROM works
        WHERE assetCode=? AND status='inprogress' AND code<>?`).get(work.assetCode, work.code);
      if (!anotherActiveWork) {
        if (work.maintenanceType === "corrective") {
          db.prepare("UPDATE items SET status='active' WHERE code=? AND status IN ('maintenance', 'down')").run(work.assetCode);
        } else {
          db.prepare("UPDATE items SET status='active' WHERE code=? AND status='maintenance'").run(work.assetCode);
        }
      }
    }
    addWorkEvent(work.code, "completed", "Kỹ thuật viên đã đánh dấu hoàn thành, chờ phê duyệt.", req.session.full_name);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  res.json(db.prepare(`SELECT ${workFields} FROM works WHERE code=?`).get(work.code));
});
api.delete("/works/:code", requireAdmin, (req, res) => {
  if (db.prepare("SELECT 1 FROM stock_movements WHERE workCode=? LIMIT 1").get(req.params.code)) {
    return sendError(res, 409, "Không thể xóa lệnh có giao dịch kho; hãy giữ lại lịch sử bảo trì.");
  }
  const result = db.prepare("DELETE FROM works WHERE code=?").run(req.params.code);
  if (!result.changes) return sendError(res, 404, "Không tìm thấy công việc.");
  res.status(204).end();
});
api.post("/works/:code/approve", requireAdmin, (req, res) => {
  const work = db.prepare("SELECT status, approvedBy FROM works WHERE code=?").get(req.params.code);
  if (!work) return sendError(res, 404, "Không tìm thấy công việc.");
  if (work.status !== "terminated") return sendError(res, 409, "Chỉ có thể phê duyệt lệnh đã được đánh dấu hoàn thành.");
  if (work.approvedBy) return sendError(res, 409, "Lệnh này đã được phê duyệt.");
  db.prepare("UPDATE works SET approvedBy=?, updatedAt=datetime('now') WHERE code=?").run(req.session.full_name, req.params.code);
  addWorkEvent(req.params.code, "approved", "Lệnh bảo trì đã được quản trị viên phê duyệt.", req.session.full_name);
  res.json({ approvedBy: req.session.full_name });
});

api.get("/items", (req, res) => res.json(db.prepare("SELECT code, name, location, date, status FROM items ORDER BY code").all()));
api.get("/items/:code/history", (req, res) => {
  const item = db.prepare("SELECT code FROM items WHERE code=?").get(req.params.code);
  if (!item) return sendError(res, 404, "Không tìm thấy thiết bị.");
  res.json(db.prepare(`SELECT code, name, date, status, maintenanceType, assignee, startedAt, completedAt, approvedBy
    FROM works WHERE assetCode=? ORDER BY date DESC, code DESC`).all(req.params.code));
});
api.post("/items", requireAdmin, validationRoute((req, res) => {
  const item = validateItem(req.body || {});
  db.prepare("INSERT INTO items (code, name, location, date, status) VALUES (@code, @name, @location, @date, @status)").run(item);
  res.status(201).json(item);
}));
api.put("/items/:code", requireAdmin, validationRoute((req, res) => {
  const item = validateItem({ ...req.body, code: req.params.code });
  const result = db.prepare("UPDATE items SET name=@name, location=@location, date=@date, status=@status WHERE code=@code").run(item);
  if (!result.changes) return sendError(res, 404, "Không tìm thấy thiết bị.");
  res.json(item);
}));
api.delete("/items/:code", requireAdmin, (req, res) => {
  if (db.prepare("SELECT 1 FROM works WHERE assetCode=? LIMIT 1").get(req.params.code)) {
    return sendError(res, 409, "Không thể xóa thiết bị đã có lịch sử bảo trì.");
  }
  const result = db.prepare("DELETE FROM items WHERE code=?").run(req.params.code);
  if (!result.changes) return sendError(res, 404, "Không tìm thấy thiết bị.");
  res.status(204).end();
});

api.get("/warehouse", (req, res) => res.json(db.prepare(`SELECT code, name, unit, qty, min, price
  FROM warehouse WHERE is_active=1 ORDER BY code`).all()));
api.post("/warehouse", requireAdmin, validationRoute((req, res) => {
  const item = validateWarehouse(req.body || {});
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO warehouse (code, name, unit, qty, min, price)
      VALUES (@code, @name, @unit, 0, @min, @price)`).run(item);
    recordStockMovement({
      warehouseCode: item.code,
      movementType: "opening",
      delta: item.qty,
      note: "Nhập tồn ban đầu",
      performedBy: req.session.full_name,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  res.status(201).json(db.prepare(`SELECT code, name, unit, qty, min, price
    FROM warehouse WHERE code=?`).get(item.code));
}));
api.put("/warehouse/:code", requireAdmin, validationRoute((req, res) => {
  const current = db.prepare("SELECT qty FROM warehouse WHERE code=? AND is_active=1").get(req.params.code);
  if (!current) return sendError(res, 404, "Không tìm thấy vật tư.");
  const item = validateWarehouse({ ...req.body, code: req.params.code, qty: current.qty });
  const result = db.prepare("UPDATE warehouse SET name=@name, unit=@unit, min=@min, price=@price WHERE code=@code AND is_active=1").run({
    code: item.code,
    name: item.name,
    unit: item.unit,
    min: item.min,
    price: item.price,
  });
  if (!result.changes) return sendError(res, 404, "Không tìm thấy vật tư.");
  res.json(db.prepare(`SELECT code, name, unit, qty, min, price
    FROM warehouse WHERE code=?`).get(item.code));
}));
api.post("/warehouse/:code/movements", requireAdmin, validationRoute((req, res) => {
  const movement = validateStockMovement(req.body || {});
  db.exec("BEGIN IMMEDIATE");
  let result;
  try {
    result = recordStockMovement({
      warehouseCode: req.params.code,
      ...movement,
      performedBy: req.session.full_name,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (error instanceof RangeError) return sendError(res, 409, error.message);
    throw error;
  }
  res.status(201).json(result);
}));
api.get("/warehouse/movements", (req, res) => {
  const rawLimit = Number(req.query.limit || 100);
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100;
  res.json(db.prepare(`SELECT m.id, m.warehouseCode, w.name AS itemName, w.unit, m.workCode,
    m.movementType, m.delta, m.qtyBefore, m.qtyAfter, m.unitPrice, m.note, m.performedBy, m.createdAt
    FROM stock_movements m JOIN warehouse w ON w.code=m.warehouseCode
    ORDER BY m.createdAt DESC, m.rowid DESC LIMIT ?`).all(limit));
});
api.get("/reports/summary", (req, res) => {
  const inventory = db.prepare(`SELECT COUNT(*) AS itemCount,
    SUM(CASE WHEN qty<=min THEN 1 ELSE 0 END) AS lowStockCount,
    COALESCE(SUM(qty*price), 0) AS inventoryValue
    FROM warehouse WHERE is_active=1`).get();
  const work = db.prepare(`SELECT
    SUM(CASE WHEN status='scheduled' AND date<date('now') THEN 1 ELSE 0 END) AS overdueCount,
    SUM(CASE WHEN status='inprogress' THEN 1 ELSE 0 END) AS activeCount
    FROM works`).get();
  const materialCost = db.prepare(`SELECT COALESCE(SUM(-delta*unitPrice), 0) AS issuedCost
    FROM stock_movements WHERE movementType IN ('issue', 'return')`).get();
  res.json({ ...inventory, ...work, ...materialCost });
});
api.delete("/warehouse/:code", requireAdmin, (req, res) => {
  const item = db.prepare("SELECT qty, is_active FROM warehouse WHERE code=?").get(req.params.code);
  if (!item || !item.is_active) return sendError(res, 404, "Không tìm thấy vật tư.");
  if (item.qty !== 0) return sendError(res, 409, "Chỉ có thể ngừng sử dụng vật tư khi tồn kho bằng 0.");
  if (db.prepare(`SELECT 1 FROM materials m JOIN works w ON w.code=m.workCode
    WHERE m.code=? AND w.status='inprogress' LIMIT 1`).get(req.params.code)) {
    return sendError(res, 409, "Không thể ngừng sử dụng vật tư đang được xuất cho lệnh chưa hoàn thành.");
  }
  const result = db.prepare("UPDATE warehouse SET is_active=0 WHERE code=?").run(req.params.code);
  if (!result.changes) return sendError(res, 404, "Không tìm thấy vật tư.");
  res.status(204).end();
});

api.get("/works/:code/materials", (req, res) => {
  res.json(db.prepare("SELECT id, workCode, code, name, staff, qty, price, addedAt FROM materials WHERE workCode=? ORDER BY addedAt").all(req.params.code));
});
api.post("/works/:code/materials", validationRoute((req, res) => {
  const work = db.prepare("SELECT code, status, approvedBy FROM works WHERE code=?").get(req.params.code);
  if (!work) return sendError(res, 404, "Không tìm thấy công việc.");
  if (work.status !== "inprogress" || work.approvedBy) return sendError(res, 409, "Chỉ có thể xuất vật tư cho lệnh đang thực hiện.");
  const material = validateMaterial(req.body || {});
  const item = db.prepare("SELECT code, name, price FROM warehouse WHERE code=? AND is_active=1").get(material.code);
  if (!item) return sendError(res, 404, "Không tìm thấy vật tư đang hoạt động trong kho.");
  const result = {
    ...material,
    name: item.name,
    staff: req.session.full_name,
    price: item.price,
    id: crypto.randomUUID(),
    workCode: req.params.code,
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    recordStockMovement({
      warehouseCode: item.code,
      workCode: req.params.code,
      movementType: "issue",
      delta: -material.qty,
      note: `Xuất dùng cho lệnh ${req.params.code}`,
      performedBy: req.session.full_name,
    });
    db.prepare("INSERT INTO materials (id, workCode, code, name, staff, qty, price) VALUES (@id, @workCode, @code, @name, @staff, @qty, @price)").run(result);
    addWorkEvent(req.params.code, "material_issued", `Xuất ${material.qty} ${db.prepare("SELECT unit FROM warehouse WHERE code=?").get(item.code).unit} ${item.name}.`, req.session.full_name);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (error instanceof RangeError) return sendError(res, 409, error.message);
    throw error;
  }
  res.status(201).json(result);
}));
api.delete("/works/:code/materials/:id", (req, res) => {
  const work = db.prepare("SELECT status, approvedBy FROM works WHERE code=?").get(req.params.code);
  if (!work) return sendError(res, 404, "Không tìm thấy công việc.");
  if (work.status !== "inprogress" || work.approvedBy) return sendError(res, 409, "Không thể hoàn trả vật tư khi lệnh không còn đang thực hiện.");
  const material = db.prepare("SELECT code, name, qty FROM materials WHERE id=? AND workCode=?").get(req.params.id, req.params.code);
  if (!material) return sendError(res, 404, "Không tìm thấy vật tư.");
  db.exec("BEGIN IMMEDIATE");
  try {
    recordStockMovement({
      warehouseCode: material.code,
      workCode: req.params.code,
      movementType: "return",
      delta: material.qty,
      note: `Hoàn trả vật tư cho lệnh ${req.params.code}`,
      performedBy: req.session.full_name,
    });
    db.prepare("DELETE FROM materials WHERE id=? AND workCode=?").run(req.params.id, req.params.code);
    addWorkEvent(req.params.code, "material_returned", `Hoàn trả ${material.qty} ${material.name} về kho.`, req.session.full_name);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  res.status(204).end();
});

api.post("/migration/local", requireAdmin, validationRoute((req, res) => {
  const body = req.body || {};
  const readArray = (value, label) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 1000) throw new ValidationError(`${label} không hợp lệ.`);
    return value;
  };
  const works = readArray(body.works, "Danh sách công việc").map((entry) => validateWork(entry, { allowUnlinked: true }));
  const items = readArray(body.items, "Danh sách thiết bị").map(validateItem);
  const warehouse = readArray(body.warehouse, "Danh sách vật tư kho").map(validateWarehouse);
  const materials = readArray(body.materials, "Danh sách vật tư sử dụng").map((entry) => {
    if (!entry || typeof entry !== "object") throw new ValidationError("Vật tư không hợp lệ.");
    const workCode = validateCode(entry.workCode, "Mã công việc");
    const id = validateString(entry.id, "Mã vật tư sử dụng", 100);
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new ValidationError("Mã vật tư sử dụng không hợp lệ.");
    return {
      ...validateMaterial(entry),
      name: validateString(entry.name, "Tên vật tư", 160),
      staff: validateString(entry.staff, "Nhân viên", 120),
      price: validateInteger(entry.price, "Đơn giá"),
      workCode,
      id,
    };
  });

  const saveWork = db.prepare(`INSERT INTO works
    (code, name, date, equip, status, "desc", priority, assignee, assetCode, maintenanceType)
    VALUES (@code, @name, @date, @equip, @status, @desc, @priority, @assignee, @assetCode, @maintenanceType)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, date=excluded.date, equip=excluded.equip,
      status=excluded.status, "desc"=excluded."desc", priority=excluded.priority, assignee=excluded.assignee,
      assetCode=excluded.assetCode, maintenanceType=excluded.maintenanceType, updatedAt=datetime('now')`);
  const saveItem = db.prepare(`INSERT INTO items (code, name, location, date, status)
    VALUES (@code, @name, @location, @date, @status)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, location=excluded.location, date=excluded.date, status=excluded.status`);
  const saveWarehouse = db.prepare(`INSERT INTO warehouse (code, name, unit, qty, min, price)
    VALUES (@code, @name, @unit, 0, @min, @price)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, unit=excluded.unit, min=excluded.min, price=excluded.price`);
  const saveMaterial = db.prepare(`INSERT OR IGNORE INTO materials (id, workCode, code, name, staff, qty, price)
    VALUES (@id, @workCode, @code, @name, @staff, @qty, @price)`);

  db.exec("BEGIN IMMEDIATE");
  try {
    items.forEach((item) => saveItem.run(item));
    for (const work of works) {
      if (!work.assetCode) {
        const linkedItem = db.prepare(`SELECT code, name FROM items
          WHERE ?=code OR ? LIKE code || ' - %'
          ORDER BY length(code) DESC LIMIT 1`).get(work.equip, work.equip);
        if (linkedItem) {
          work.assetCode = linkedItem.code;
          work.equip = `${linkedItem.code} - ${linkedItem.name}`;
        }
      }
      if (work.assetCode) {
        const linkedItem = db.prepare("SELECT code, name FROM items WHERE code=?").get(work.assetCode);
        if (!linkedItem) throw new ValidationError(`Không tìm thấy thiết bị "${work.assetCode}" của lệnh bảo trì.`);
        work.equip = `${linkedItem.code} - ${linkedItem.name}`;
      }
      saveWork.run(work);
    }
    for (const item of warehouse) {
      saveWarehouse.run({ code: item.code, name: item.name, unit: item.unit, min: item.min, price: item.price });
      const current = db.prepare("SELECT qty, price FROM warehouse WHERE code=?").get(item.code);
      if (current.qty !== item.qty) {
        db.prepare("UPDATE warehouse SET qty=? WHERE code=?").run(item.qty, item.code);
        db.prepare(`INSERT INTO stock_movements
          (id, warehouseCode, movementType, delta, qtyBefore, qtyAfter, unitPrice, note, performedBy)
          VALUES (?, ?, 'migration', ?, ?, ?, ?, ?, ?)`).run(
          crypto.randomUUID(), item.code, item.qty - current.qty, current.qty, item.qty,
          item.price, "Điều chỉnh theo dữ liệu được nhập từ trình duyệt", req.session.full_name,
        );
      }
    }
    for (const material of materials) {
      if (!db.prepare("SELECT 1 FROM works WHERE code=?").get(material.workCode)) {
        throw new ValidationError(`Không tìm thấy công việc "${material.workCode}" của vật tư.`);
      }
      saveMaterial.run(material);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  res.json({ imported: { works: works.length, items: items.length, warehouse: warehouse.length, materials: materials.length } });
}));

app.use("/api", verifySameOrigin, verifyCsrf, api);

const publicPages = new Set(["index.html", "login.html", "data-manager.js", "login.js", "supabase-config.js", "app.css"]);
const protectedPages = new Set(["dashboard.html", "items.html", "warehouse.html", "reports.html", "work-detail.html", "users.html", "account.html", "supabase-import.html"]);
const adminPages = new Set(["users.html", "supabase-import.html"]);
const staticTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

app.get("/", (req, res) => res.redirect("/index.html"));
app.get("/{*path}", (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.originalUrl, "http://localhost").pathname);
  } catch {
    return sendError(res, 400, "Đường dẫn không hợp lệ.");
  }
  const filename = path.posix.basename(pathname);
  if (protectedPages.has(filename)) {
    const id = readCookie(req);
    const session = id && db.prepare(`SELECT sessions.user_id, users.role FROM sessions JOIN users ON users.id=sessions.user_id
      WHERE sessions.id_hash=? AND sessions.expires_at>? AND users.is_active=1`).get(hash(id), Date.now());
    if (!session?.user_id) return res.redirect(`/login.html?next=${encodeURIComponent(filename)}`);
    if (adminPages.has(filename) && session.role !== "admin") return res.redirect("/dashboard.html");
  } else if (!publicPages.has(filename)) {
    return sendError(res, 404, "Không tìm thấy trang.");
  }
  const filePath = path.join(__dirname, filename);
  if (path.extname(filename) === ".html") {
    fs.readFile(filePath, "utf8", (error, html) => {
      if (error) return sendError(res, 404, "Không tìm thấy trang.");
      const nonce = res.locals.cspNonce;
      res.type(staticTypes[".html"]).send(html.replace(/<script\b/gi, `<script nonce="${nonce}"`));
    });
    return;
  }
  res.type(staticTypes[path.extname(filename)]).sendFile(filePath, (error) => {
    if (error && !res.headersSent) sendError(res, 404, "Không tìm thấy trang.");
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === "entity.parse.failed") return sendError(res, 400, "Dữ liệu JSON không hợp lệ.");
  if (error?.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || error?.code === "SQLITE_CONSTRAINT_UNIQUE" || error?.message?.includes("UNIQUE constraint failed")) {
    return sendError(res, 409, "Mã đã tồn tại.");
  }
  console.error("Yêu cầu thất bại:", error);
  sendError(res, 500, "Đã xảy ra lỗi máy chủ.");
});

async function createUser(email, fullName, role) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) throw new Error("Email không hợp lệ.");
  const name = validateString(fullName, "Tên người dùng", 120);
  validateEnum(role, ["admin", "technician"], "Vai trò");
  if (process.stdin.isTTY) {
    process.stdout.write("Mật khẩu mới (tối thiểu 12 ký tự): ");
    const password = await readHiddenInput();
    process.stdout.write("\nNhập lại mật khẩu: ");
    const confirmation = await readHiddenInput();
    process.stdout.write("\n");
    if (password !== confirmation) throw new Error("Hai mật khẩu không khớp.");
    if (password.length < 12 || password.length > 256) throw new Error("Mật khẩu phải có từ 12 đến 256 ký tự.");
    const salt = crypto.randomBytes(16);
    const derived = await scrypt(password, salt, 64);
    db.prepare("INSERT INTO users (email, password_hash, full_name, role) VALUES (?, ?, ?, ?)").run(normalizedEmail, `${salt.toString("hex")}$${derived.toString("hex")}`, name, role);
    console.log(`Đã tạo ${role}: ${normalizedEmail}`);
    return;
  }
  throw new Error("Hãy chạy lệnh này trong terminal tương tác để nhập mật khẩu an toàn.");
}

function readHiddenInput() {
  return new Promise((resolve, reject) => {
    if (!process.stdin.setRawMode) return reject(new Error("Terminal hiện tại không hỗ trợ nhập mật khẩu an toàn."));
    let value = "";
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdin.off("data", onData);
          process.stdin.pause();
          reject(new Error("Đã hủy."));
          return;
        }
        if (char === "\r" || char === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.off("data", onData);
          process.stdin.pause();
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " " && value.length < 256) value += char;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

if (require.main === module) {
  if (process.argv[2] === "--create-admin" || process.argv[2] === "--create-user") {
    const role = process.argv[2] === "--create-admin" ? "admin" : process.argv[5];
    createUser(process.argv[3], process.argv[4], role)
      .then(() => db.close())
      .catch((error) => {
        console.error(error.message);
        db.close();
        process.exitCode = 1;
      });
  } else {
    const server = app.listen(PORT, "127.0.0.1", () => {
      console.log(`MyxTech đang chạy tại http://127.0.0.1:${PORT}`);
    });
    process.on("SIGINT", () => server.close(() => {
      db.close();
      process.exit(0);
    }));
    process.on("SIGTERM", () => server.close(() => {
      db.close();
      process.exit(0);
    }));
  }
}

module.exports = { app, db };
