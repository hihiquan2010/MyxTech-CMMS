"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");

test("upgrades the previous database schema without losing work or stock balances", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "myxtech-cmms-migration-"));
  const databasePath = path.join(dataDir, "myxtech.sqlite");
  let migratedDb;
  const legacyDb = new DatabaseSync(databasePath);
  legacyDb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'technician')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sessions (
      id_hash TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE works (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      equip TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('inprogress', 'terminated', 'scheduled', 'priority')),
      "desc" TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
      assignee TEXT NOT NULL DEFAULT '',
      approvedBy TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE items (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT NOT NULL,
      date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'maintenance', 'down'))
    );
    CREATE TABLE warehouse (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK (qty >= 0),
      min INTEGER NOT NULL CHECK (min >= 0),
      price INTEGER NOT NULL CHECK (price >= 0)
    );
    CREATE TABLE materials (
      id TEXT PRIMARY KEY,
      workCode TEXT NOT NULL REFERENCES works(code) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      staff TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK (qty > 0),
      price INTEGER NOT NULL CHECK (price >= 0),
      addedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX materials_work ON materials(workCode);
    INSERT INTO items VALUES ('OLD-01', 'Máy cũ', 'Nhà máy A', '2020-01-01', 'active');
    INSERT INTO works (code, name, date, equip, status, assignee)
      VALUES ('OLD-WORK', 'Bảo trì cũ', '2026-01-01', 'OLD-01 - Máy cũ', 'scheduled', 'Kỹ thuật viên');
    INSERT INTO warehouse VALUES ('OLD-PART', 'Phụ tùng cũ', 'Cái', 5, 1, 20000);
  `);
  legacyDb.close();

  try {
    const startup = spawnSync(process.execPath, ["-e", "const { db } = require('./server.js'); db.close();"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, MYXTECH_DATA_DIR: dataDir },
      encoding: "utf8",
    });
    assert.equal(startup.status, 0, startup.stderr || startup.stdout);

    migratedDb = new DatabaseSync(databasePath);
    const work = migratedDb.prepare("SELECT code, assetCode, maintenanceType FROM works WHERE code='OLD-WORK'").get();
    assert.equal(work.code, "OLD-WORK");
    assert.equal(work.assetCode, "OLD-01");
    assert.equal(work.maintenanceType, "preventive");
    assert.equal(migratedDb.prepare("SELECT qty FROM warehouse WHERE code='OLD-PART'").get().qty, 5);
    const opening = migratedDb.prepare("SELECT qtyBefore, qtyAfter, movementType FROM stock_movements WHERE warehouseCode='OLD-PART'").get();
    assert.equal(opening.qtyBefore, 0);
    assert.equal(opening.qtyAfter, 5);
    assert.equal(opening.movementType, "opening");
    assert.equal(migratedDb.prepare("SELECT COUNT(*) AS count FROM work_events WHERE workCode='OLD-WORK'").get().count, 1);
    assert.deepEqual(migratedDb.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    if (migratedDb) migratedDb.close();
    for (const name of fs.readdirSync(dataDir)) {
      if (name.startsWith("myxtech.sqlite")) fs.rmSync(path.join(dataDir, name), { force: true });
    }
    fs.rmdirSync(dataDir);
  }
});
