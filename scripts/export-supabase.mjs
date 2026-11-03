import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = path.join(root, "data", "myxtech.sqlite");
const outputPath = path.resolve(process.argv[2] || path.join(root, "data", "supabase-import.json"));

if (!fs.existsSync(databasePath)) {
  throw new Error(`CMMS SQLite database not found: ${databasePath}`);
}

const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const rows = (sql) => db.prepare(sql).all();
  const exportData = {
    items: rows("SELECT code, name, location, date, status FROM items ORDER BY code"),
    works: rows(`SELECT code, name, "desc" AS description, date, equip, status, priority,
      maintenanceType, assignee, approvedBy, startedAt, completedAt, assetCode
      FROM works ORDER BY code`),
    warehouse: rows("SELECT code, name, unit, qty, min, price, is_active FROM warehouse ORDER BY code"),
    materials: rows(`SELECT workCode, code, name, staff, qty, price, addedAt
      FROM materials ORDER BY workCode, addedAt`),
    workEvents: rows(`SELECT workCode, eventType, note, actor, createdAt
      FROM work_events ORDER BY workCode, createdAt`),
    stockMovements: rows(`SELECT warehouseCode, workCode, movementType, delta, qtyBefore,
      qtyAfter, unitPrice, note, performedBy, createdAt
      FROM stock_movements ORDER BY createdAt, id`),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(exportData, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Exported CMMS business data to: ${outputPath}`);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(exportData).map(([key, value]) => [key, value.length]))));
  console.log("User password hashes and login sessions were not exported.");
} finally {
  db.close();
}
