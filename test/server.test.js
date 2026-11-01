"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "myxtech-cmms-test-"));
process.env.MYXTECH_DATA_DIR = dataDir;

const { app, db } = require("../server.js");
let server;
let baseUrl;

function extractCookie(response) {
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie, "expected a session cookie");
  return cookie.split(";")[0];
}

async function createSession(email, password) {
  const csrfResponse = await fetch(`${baseUrl}/api/auth/csrf`);
  const csrfCookie = extractCookie(csrfResponse);
  const { csrfToken } = await csrfResponse.json();
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      Cookie: csrfCookie,
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ email, password }),
  });
  return { response, cookie: response.ok ? extractCookie(response) : null };
}

function apiHeaders(cookie, csrfToken, withBody = false) {
  return {
    Origin: baseUrl,
    Cookie: cookie,
    "X-CSRF-Token": csrfToken,
    ...(withBody ? { "Content-Type": "application/json" } : {}),
  };
}

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const password = "Test-password-1234";
  const salt = crypto.randomBytes(16);
  const passwordHash = crypto.scryptSync(password, salt, 64);
  const insertUser = db.prepare("INSERT INTO users (email, password_hash, full_name, role) VALUES (?, ?, ?, ?)");
  insertUser.run("admin@example.test", `${salt.toString("hex")}$${passwordHash.toString("hex")}`, "Test Admin", "admin");
  insertUser.run("tech@example.test", `${salt.toString("hex")}$${passwordHash.toString("hex")}`, "Test Technician", "technician");
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("serves public pages while protecting application pages and private files", async () => {
  const landing = await fetch(`${baseUrl}/`, { redirect: "manual" });
  assert.equal(landing.status, 302);
  assert.equal(landing.headers.get("location"), "/index.html");

  const protectedPage = await fetch(`${baseUrl}/dashboard.html`, { redirect: "manual" });
  assert.equal(protectedPage.status, 302);
  assert.match(protectedPage.headers.get("location"), /^\/login\.html\?next=/);

  const privateUsers = await fetch(`${baseUrl}/users.json`);
  assert.equal(privateUsers.status, 404);
  assert.match(privateUsers.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.doesNotMatch(privateUsers.headers.get("content-security-policy"), /script-src[^;]*unsafe-inline/);
});

test("enforces CSRF, validates API data, and applies role-based permissions", async () => {
  const csrfResponse = await fetch(`${baseUrl}/api/auth/csrf`);
  const anonymousCookie = extractCookie(csrfResponse);
  const { csrfToken } = await csrfResponse.json();
  const csrfRejected = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl, Cookie: anonymousCookie },
    body: JSON.stringify({ email: "admin@example.test", password: "Test-password-1234" }),
  });
  assert.equal(csrfRejected.status, 403);

  const adminLogin = await createSession("admin@example.test", "Test-password-1234");
  assert.equal(adminLogin.response.status, 200);
  const adminBody = await adminLogin.response.json();
  assert.equal(adminBody.user.role, "admin");
  assert.ok(adminBody.csrfToken);
  const dashboardPage = await fetch(`${baseUrl}/dashboard.html`, { headers: { Cookie: adminLogin.cookie } });
  const dashboardHtml = await dashboardPage.text();
  const nonce = dashboardPage.headers.get("content-security-policy").match(/'nonce-([^']+)'/)[1];
  assert.match(dashboardHtml, new RegExp(`<script nonce="${nonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  const usersPage = await fetch(`${baseUrl}/users.html`, { headers: { Cookie: adminLogin.cookie } });
  assert.equal(usersPage.status, 200);
  assert.match(await usersPage.text(), /Tài khoản người dùng/);

  const worksResponse = await fetch(`${baseUrl}/api/works`, {
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken),
  });
  assert.equal(worksResponse.status, 200);
  assert.equal((await worksResponse.json()).length, 6);

  const invalidWork = await fetch(`${baseUrl}/api/works`, {
    method: "POST",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify({ code: "<script>", name: "Bad", date: "2026-03-04", equip: "A", status: "invalid" }),
  });
  assert.equal(invalidWork.status, 400);

  const newWork = {
    code: "TEST-001",
    name: "Kiểm tra thiết bị",
    date: "2026-11-01",
    equip: "AC-0008",
    assetCode: "AC-0008",
    status: "scheduled",
    desc: "Dòng thứ nhất\nDòng thứ hai",
  };
  const created = await fetch(`${baseUrl}/api/works`, {
    method: "POST",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify(newWork),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).desc, "Dòng thứ nhất\nDòng thứ hai");

  const techLogin = await createSession("tech@example.test", "Test-password-1234");
  const techBody = await techLogin.response.json();
  const technicianCannotListUsers = await fetch(`${baseUrl}/api/users`, {
    headers: apiHeaders(techLogin.cookie, techBody.csrfToken),
  });
  assert.equal(technicianCannotListUsers.status, 403);
  const technicianCannotOpenUsersPage = await fetch(`${baseUrl}/users.html`, {
    headers: { Cookie: techLogin.cookie },
    redirect: "manual",
  });
  assert.equal(technicianCannotOpenUsersPage.status, 302);
  assert.equal(technicianCannotOpenUsersPage.headers.get("location"), "/dashboard.html");
  const technicianCanOpenOwnAccount = await fetch(`${baseUrl}/account.html`, {
    headers: { Cookie: techLogin.cookie },
  });
  assert.equal(technicianCanOpenOwnAccount.status, 200);
  assert.match(await technicianCanOpenOwnAccount.text(), /Đổi mật khẩu/);

  const createdUserResponse = await fetch(`${baseUrl}/api/users`, {
    method: "POST",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify({
      full_name: "New CMMS Operator",
      email: "operator@example.test",
      role: "technician",
      password: "A-strong-test-password",
    }),
  });
  assert.equal(createdUserResponse.status, 201);
  const createdUser = await createdUserResponse.json();
  assert.equal(createdUser.email, "operator@example.test");
  assert.equal(Object.hasOwn(createdUser, "password_hash"), false);
  const tooShortPassword = await fetch(`${baseUrl}/api/users`, {
    method: "POST",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify({
      full_name: "Invalid Operator",
      email: "invalid@example.test",
      role: "technician",
      password: "short",
    }),
  });
  assert.equal(tooShortPassword.status, 400);
  const selfDeactivation = await fetch(`${baseUrl}/api/users/${adminBody.user.id}/status`, {
    method: "PATCH",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify({ is_active: false }),
  });
  assert.equal(selfDeactivation.status, 409);

  const newUserLogin = await createSession("operator@example.test", "A-strong-test-password");
  assert.equal(newUserLogin.response.status, 200);
  const operatorBody = await newUserLogin.response.clone().json();
  const wrongCurrentPassword = await fetch(`${baseUrl}/api/auth/password`, {
    method: "POST",
    headers: apiHeaders(newUserLogin.cookie, operatorBody.csrfToken, true),
    body: JSON.stringify({ currentPassword: "wrong-password", newPassword: "A-different-test-password" }),
  });
  assert.equal(wrongCurrentPassword.status, 403);
  const changePassword = await fetch(`${baseUrl}/api/auth/password`, {
    method: "POST",
    headers: apiHeaders(newUserLogin.cookie, operatorBody.csrfToken, true),
    body: JSON.stringify({ currentPassword: "A-strong-test-password", newPassword: "A-different-test-password" }),
  });
  assert.equal(changePassword.status, 200);
  const oldPasswordLogin = await createSession("operator@example.test", "A-strong-test-password");
  assert.equal(oldPasswordLogin.response.status, 401);
  const changedPasswordLogin = await createSession("operator@example.test", "A-different-test-password");
  assert.equal(changedPasswordLogin.response.status, 200);
  const changedPasswordBody = await changedPasswordLogin.response.clone().json();
  const disableUser = await fetch(`${baseUrl}/api/users/${createdUser.id}/status`, {
    method: "PATCH",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify({ is_active: false }),
  });
  assert.equal(disableUser.status, 200);
  const revokedSession = await fetch(`${baseUrl}/api/auth/me`, {
    headers: apiHeaders(changedPasswordLogin.cookie, changedPasswordBody.csrfToken),
  });
  assert.equal(revokedSession.status, 401);
  const disabledUserLogin = await createSession("operator@example.test", "A-different-test-password");
  assert.equal(disabledUserLogin.response.status, 401);
  const reenableUser = await fetch(`${baseUrl}/api/users/${createdUser.id}/status`, {
    method: "PATCH",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify({ is_active: true }),
  });
  assert.equal(reenableUser.status, 200);

  const deniedWarehouseWrite = await fetch(`${baseUrl}/api/warehouse`, {
    method: "POST",
    headers: apiHeaders(techLogin.cookie, techBody.csrfToken, true),
    body: JSON.stringify({ code: "TEST-ITEM", name: "Vật tư", unit: "Cái", qty: 1, min: 0, price: 100 }),
  });
  assert.equal(deniedWarehouseWrite.status, 403);

  const stockBeforeReceipt = db.prepare("SELECT qty FROM warehouse WHERE code='BLT-005'").get().qty;
  const directStockEdit = await fetch(`${baseUrl}/api/warehouse/BLT-005`, {
    method: "PUT",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify({ code: "BLT-005", name: "Bu lông M8", unit: "Hộp", qty: 0, min: 20, price: 50000 }),
  });
  assert.equal(directStockEdit.status, 200);
  assert.equal(db.prepare("SELECT qty FROM warehouse WHERE code='BLT-005'").get().qty, stockBeforeReceipt);
  const rejectedAdjustment = await fetch(`${baseUrl}/api/warehouse/BLT-005/movements`, {
    method: "POST",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify({ type: "adjustment", quantity: -(stockBeforeReceipt + 1), note: "Kiểm thử không cho tồn âm" }),
  });
  assert.equal(rejectedAdjustment.status, 409);
  assert.equal(db.prepare("SELECT qty FROM warehouse WHERE code='BLT-005'").get().qty, stockBeforeReceipt);
  const receipt = await fetch(`${baseUrl}/api/warehouse/BLT-005/movements`, {
    method: "POST",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify({ type: "receipt", quantity: 3, note: "Nhập hàng thử nghiệm" }),
  });
  assert.equal(receipt.status, 201);
  assert.equal(db.prepare("SELECT qty FROM warehouse WHERE code='BLT-005'").get().qty, stockBeforeReceipt + 3);
  const adjustment = await fetch(`${baseUrl}/api/warehouse/BLT-005/movements`, {
    method: "POST",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify({ type: "adjustment", quantity: -3, note: "Hoàn nguyên dữ liệu kiểm thử" }),
  });
  assert.equal(adjustment.status, 201);
  assert.equal(db.prepare("SELECT qty FROM warehouse WHERE code='BLT-005'").get().qty, stockBeforeReceipt);

  const techCanCreateWork = await fetch(`${baseUrl}/api/works`, {
    method: "POST",
    headers: apiHeaders(techLogin.cookie, techBody.csrfToken, true),
    body: JSON.stringify({ ...newWork, code: "TEST-002" }),
  });
  assert.equal(techCanCreateWork.status, 201);

  const stockWorkResponse = await fetch(`${baseUrl}/api/works`, {
    method: "POST",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify({ ...newWork, code: "TEST-STOCK-001" }),
  });
  assert.equal(stockWorkResponse.status, 201);
  const startWork = await fetch(`${baseUrl}/api/works/TEST-STOCK-001/start`, {
    method: "POST",
    headers: apiHeaders(techLogin.cookie, techBody.csrfToken, true),
    body: JSON.stringify({}),
  });
  assert.equal(startWork.status, 200);
  assert.equal((await startWork.json()).status, "inprogress");
  assert.equal(db.prepare("SELECT status FROM items WHERE code='AC-0008'").get().status, "maintenance");
  const duplicateAssetWork = await fetch(`${baseUrl}/api/works`, {
    method: "POST",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify({ ...newWork, code: "TEST-DUPLICATE-ASSET" }),
  });
  assert.equal(duplicateAssetWork.status, 201);
  const duplicateStart = await fetch(`${baseUrl}/api/works/TEST-DUPLICATE-ASSET/start`, {
    method: "POST",
    headers: apiHeaders(techLogin.cookie, techBody.csrfToken, true),
    body: JSON.stringify({}),
  });
  assert.equal(duplicateStart.status, 409);

  const beforeIssue = db.prepare("SELECT qty FROM warehouse WHERE code='BLT-005'").get().qty;
  const issueMaterial = await fetch(`${baseUrl}/api/works/TEST-STOCK-001/materials`, {
    method: "POST",
    headers: apiHeaders(techLogin.cookie, techBody.csrfToken, true),
    body: JSON.stringify({ code: "BLT-005", qty: 2, price: 1, staff: "forged" }),
  });
  assert.equal(issueMaterial.status, 201);
  const issued = await issueMaterial.json();
  assert.equal(issued.staff, "Test Technician");
  assert.equal(issued.price, 50000);
  assert.equal(db.prepare("SELECT qty FROM warehouse WHERE code='BLT-005'").get().qty, beforeIssue - 2);

  const insufficientStock = await fetch(`${baseUrl}/api/works/TEST-STOCK-001/materials`, {
    method: "POST",
    headers: apiHeaders(techLogin.cookie, techBody.csrfToken, true),
    body: JSON.stringify({ code: "BLT-005", qty: beforeIssue, price: 0 }),
  });
  assert.equal(insufficientStock.status, 409);
  assert.equal(db.prepare("SELECT qty FROM warehouse WHERE code='BLT-005'").get().qty, beforeIssue - 2);

  const returnedMaterial = await fetch(`${baseUrl}/api/works/TEST-STOCK-001/materials/${encodeURIComponent(issued.id)}`, {
    method: "DELETE",
    headers: apiHeaders(techLogin.cookie, techBody.csrfToken),
  });
  assert.equal(returnedMaterial.status, 204);
  assert.equal(db.prepare("SELECT qty FROM warehouse WHERE code='BLT-005'").get().qty, beforeIssue);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM stock_movements WHERE workCode='TEST-STOCK-001' AND movementType='return'").get().count, 1);
  const workEvents = await fetch(`${baseUrl}/api/works/TEST-STOCK-001/events`, {
    headers: apiHeaders(techLogin.cookie, techBody.csrfToken),
  });
  assert.ok((await workEvents.json()).some((event) => event.eventType === "material_returned"));

  const completeWork = await fetch(`${baseUrl}/api/works/TEST-STOCK-001/complete`, {
    method: "POST",
    headers: apiHeaders(techLogin.cookie, techBody.csrfToken, true),
    body: JSON.stringify({}),
  });
  assert.equal(completeWork.status, 200);
  assert.equal((await completeWork.json()).status, "terminated");
  assert.equal(db.prepare("SELECT status FROM items WHERE code='AC-0008'").get().status, "active");
  const approveWork = await fetch(`${baseUrl}/api/works/TEST-STOCK-001/approve`, {
    method: "POST",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify({}),
  });
  assert.equal(approveWork.status, 200);
  const approvedWork = await fetch(`${baseUrl}/api/works/TEST-STOCK-001`, {
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken),
  });
  assert.equal((await approvedWork.json()).approvedBy, "Test Admin");
  const duplicateApproval = await fetch(`${baseUrl}/api/works/TEST-STOCK-001/approve`, {
    method: "POST",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify({}),
  });
  assert.equal(duplicateApproval.status, 409);
  const linkedHistory = await fetch(`${baseUrl}/api/items/AC-0008/history`, {
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken),
  });
  assert.ok((await linkedHistory.json()).some((work) => work.code === "TEST-STOCK-001"));
  const cannotDeleteWithAudit = await fetch(`${baseUrl}/api/works/TEST-STOCK-001`, {
    method: "DELETE",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken),
  });
  assert.equal(cannotDeleteWithAudit.status, 409);

  const techCannotDeleteWork = await fetch(`${baseUrl}/api/works/TEST-002`, {
    method: "DELETE",
    headers: apiHeaders(techLogin.cookie, techBody.csrfToken),
  });
  assert.equal(techCannotDeleteWork.status, 403);

  const deleted = await fetch(`${baseUrl}/api/works/TEST-001`, {
    method: "DELETE",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken),
  });
  assert.equal(deleted.status, 204);
  const deleteUnusedDuplicate = await fetch(`${baseUrl}/api/works/TEST-DUPLICATE-ASSET`, {
    method: "DELETE",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken),
  });
  assert.equal(deleteUnusedDuplicate.status, 204);

  const migration = await fetch(`${baseUrl}/api/migration/local`, {
    method: "POST",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify({
      works: [{
        code: "MIG-001",
        name: "Công việc cũ",
        date: "2026-11-01",
        equip: "AC-0008",
        status: "scheduled",
      }],
      items: [{
        code: "MIG-ITEM",
        name: "Thiết bị cũ",
        location: "Nhà máy A",
        date: "2026-10-01",
        status: "active",
      }],
      warehouse: [{
        code: "MIG-PART",
        name: "Vật tư cũ",
        unit: "Cái",
        qty: 4,
        min: 2,
        price: 500,
      }],
      materials: [{
        id: "mat_legacy_1",
        workCode: "MIG-001",
        code: "MIG-PART",
        name: "Vật tư cũ",
        staff: "Test Technician",
        qty: 1,
        price: 500,
      }],
    }),
  });
  assert.equal(migration.status, 200);
  assert.deepEqual((await migration.json()).imported, { works: 1, items: 1, warehouse: 1, materials: 1 });
  const migratedMaterials = await fetch(`${baseUrl}/api/works/MIG-001/materials`, {
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken),
  });
  assert.equal((await migratedMaterials.json())[0].id, "mat_legacy_1");

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: apiHeaders(adminLogin.cookie, adminBody.csrfToken, true),
    body: JSON.stringify({}),
  });
  assert.equal(logout.status, 204);
  const expiredSession = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: adminLogin.cookie },
  });
  assert.equal(expiredSession.status, 401);
});
