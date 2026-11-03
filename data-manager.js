(function (global) {
  "use strict";

  const config = global.MYXTECH_SUPABASE;
  if (!config?.url || !config?.publishableKey) {
    throw new Error("Thiếu cấu hình Supabase công khai.");
  }
  const API_URL = config.url.replace(/\/+$/, "");
  const PUBLISHABLE_KEY = config.publishableKey;
  const SESSION_KEY = "myxtech_supabase_session";
  const projectPath = config.githubPagesBasePath.replace(/\/+$/, "");
  const APP_BASE_PATH = location.hostname.endsWith(".github.io") && location.pathname.startsWith(`${projectPath}/`)
    ? projectPath
    : "";
  let currentUser = null;
  let initialization;

  function getStoredSession() {
    try {
      const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      return session?.refresh_token && session?.access_token ? session : null;
    } catch {
      return null;
    }
  }

  function saveSession(session) {
    if (!session?.access_token || !session?.refresh_token) {
      throw new Error("Supabase không trả về phiên đăng nhập hợp lệ.");
    }
    const stored = {
      ...session,
      expires_at: session.expires_at || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600),
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(stored));
    return stored;
  }

  function pageUrl(path) {
    return `${APP_BASE_PATH}/${String(path).replace(/^\/+/, "")}`;
  }

  function redirectToLogin() {
    const currentPage = location.pathname.split("/").pop();
    const protectedPages = new Set([
      "dashboard.html", "items.html", "warehouse.html", "reports.html",
      "work-detail.html", "users.html", "account.html", "supabase-import.html",
    ]);
    if (protectedPages.has(currentPage)) {
      location.replace(pageUrl(`login.html?next=${encodeURIComponent(currentPage)}`));
    }
  }

  async function authRequest(path, { method = "GET", body, token } = {}) {
    const response = await fetch(`${API_URL}/auth/v1/${path}`, {
      method,
      headers: {
        apikey: PUBLISHABLE_KEY,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.msg || result?.message || result?.error_description || result?.error || "Xác thực Supabase không thành công.");
    return result;
  }

  async function getSession() {
    let session = getStoredSession();
    if (!session) return null;
    const expiresAt = Number(session.expires_at || 0);
    if (expiresAt && expiresAt * 1000 < Date.now() + 30000) {
      try {
        session = saveSession(await authRequest("token?grant_type=refresh_token", {
          method: "POST",
          body: { refresh_token: session.refresh_token },
        }));
      } catch (error) {
        sessionStorage.removeItem(SESSION_KEY);
        currentUser = null;
        redirectToLogin();
        throw new Error(`Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại. ${error.message}`);
      }
    }
    return session;
  }

  async function supabaseRequest(table, { method = "GET", query = "", body, prefer = "" } = {}) {
    const session = await getSession();
    const response = await fetch(`${API_URL}/rest/v1/${table}${query ? `?${query}` : ""}`, {
      method,
      headers: {
        apikey: PUBLISHABLE_KEY,
        Authorization: `Bearer ${session?.access_token || PUBLISHABLE_KEY}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(result?.message || result?.hint || result?.details || result?.error_description || result?.error || "Yêu cầu Supabase không thành công.");
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async function rpc(name, args = {}) {
    const session = await getSession();
    const response = await fetch(`${API_URL}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: PUBLISHABLE_KEY,
        Authorization: `Bearer ${session?.access_token || PUBLISHABLE_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(args),
    });
    const result = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(result?.message || result?.details || result?.hint || "Thao tác Supabase không thành công.");
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function queryString(values) {
    return new URLSearchParams(values).toString();
  }

  function mapItem(item) {
    return {
      code: item.asset_code,
      name: item.name,
      location: item.location || "",
      date: item.purchase_date || item.created_at?.slice(0, 10) || "",
      status: item.status === "Active" ? "active" : item.status === "Maintenance" ? "maintenance" : "down",
    };
  }

  function mapWarehouse(item) {
    return {
      code: item.item_code,
      name: item.name,
      unit: item.unit || "",
      qty: item.stock_quantity,
      min: item.min_stock_level,
      price: item.price || 0,
    };
  }

  function mapWork(work) {
    const item = work.devices;
    const equip = item ? `${item.asset_code} - ${item.name}` : work.order_code;
    const status = work.status === "In Progress" ? "inprogress"
      : work.status === "Completed" || work.status === "Cancelled" ? "terminated"
        : work.priority === "Urgent" ? "priority" : "scheduled";
    return {
      code: work.order_code,
      name: work.title || work.description || work.order_code,
      date: work.scheduled_date,
      equip,
      status,
      desc: work.description || "",
      priority: ["High", "Urgent"].includes(work.priority) ? "high" : "normal",
      assignee: work.assigned_to || "",
      approvedBy: work.approved_by || "",
      assetCode: item?.asset_code || "",
      maintenanceType: ({ Preventative: "preventive", Corrective: "corrective", Inspection: "inspection" })[work.maintenance_type] || "preventive",
      startedAt: work.started_at,
      completedAt: work.completed_at,
      createdAt: work.created_at,
      updatedAt: work.updated_at,
    };
  }

  async function getWorkRow(code) {
    const rows = await supabaseRequest("maintenance_orders", {
      query: queryString({ select: "*,devices!maintenance_orders_device_id_fkey(asset_code,name)", order_code: `eq.${code}`, limit: "1" }),
    });
    return rows?.[0] || null;
  }

  async function getDeviceId(assetCode) {
    if (!assetCode) return null;
    const rows = await supabaseRequest("devices", {
      query: queryString({ select: "id", asset_code: `eq.${assetCode}`, limit: "1" }),
    });
    if (!rows?.length) throw new Error(`Không tìm thấy thiết bị "${assetCode}".`);
    return rows[0].id;
  }

  function mapWorkInput(work) {
    const type = ({ preventive: "Preventative", corrective: "Corrective", inspection: "Inspection" })[work.maintenanceType] || "Preventative";
    return {
      order_code: work.code,
      title: work.name,
      description: work.desc || "",
      scheduled_date: work.date,
      maintenance_type: type,
      priority: work.priority === "high" ? "High" : work.status === "priority" ? "Urgent" : "Normal",
      assigned_to: work.assignee || "",
    };
  }

  function emitChange(resource) {
    global.dispatchEvent(new CustomEvent("myxtech:data-changed", { detail: { resource } }));
  }

  function clearLegacyAuthData() {
    try {
      localStorage.removeItem("currentUser");
      localStorage.removeItem("accessToken");
    } catch (error) {
      console.warn("Không thể xóa phiên đăng nhập cũ trên trình duyệt.", error);
    }
  }

  const Works = {
    async getAll() {
      const rows = await supabaseRequest("maintenance_orders", {
        query: queryString({ select: "*,devices!maintenance_orders_device_id_fkey(asset_code,name)", order: "scheduled_date.desc,order_code.asc" }),
      });
      return rows.map(mapWork);
    },
    async getById(code) {
      const row = await getWorkRow(code);
      return row ? mapWork(row) : null;
    },
    async search({ search = "", status = "all", date = "" } = {}) {
      const query = search.trim().toLocaleLowerCase("vi");
      return (await this.getAll()).filter((work) => {
        const searchable = `${work.code} ${work.name} ${work.equip}`.toLocaleLowerCase("vi");
        return (!query || searchable.includes(query)) &&
          (status === "all" || work.status === status) &&
          (!date || work.date === date);
      });
    },
    async add(work) {
      const deviceId = await getDeviceId(work.assetCode);
      const result = await supabaseRequest("maintenance_orders", {
        method: "POST",
        query: queryString({ select: "order_code" }),
        prefer: "return=representation",
        body: { ...mapWorkInput(work), device_id: deviceId, status: "Pending" },
      });
      emitChange("works");
      const created = await this.getById(result[0].order_code);
      await rpc("cmms_add_work_event", { p_order_code: created.code, p_note: "Lệnh bảo trì được tạo và lên lịch." });
      return created;
    },
    async update(code, updates) {
      const current = await this.getById(code);
      if (!current) throw new Error("Không tìm thấy công việc.");
      const deviceId = await getDeviceId(updates.assetCode ?? current.assetCode);
      await supabaseRequest("maintenance_orders", {
        method: "PATCH",
        query: queryString({ order_code: `eq.${code}` }),
        prefer: "return=minimal",
        body: { ...mapWorkInput({ ...current, ...updates }), device_id: deviceId },
      });
      emitChange("works");
      await rpc("cmms_add_work_event", { p_order_code: code, p_note: "Thông tin lệnh bảo trì được cập nhật." });
      return this.getById(code);
    },
    async remove(code) {
      await rpc("cmms_delete_work", { p_order_code: code });
      emitChange("works");
      return null;
    },
    async approve(code) {
      const result = await rpc("cmms_transition_work", { p_order_code: code, p_action: "approve" });
      emitChange("works");
      return result;
    },
    async start(code) {
      const result = await rpc("cmms_transition_work", { p_order_code: code, p_action: "start" });
      emitChange("works");
      emitChange("items");
      return this.getById(code);
    },
    async complete(code) {
      const result = await rpc("cmms_transition_work", { p_order_code: code, p_action: "complete" });
      emitChange("works");
      emitChange("items");
      return this.getById(code);
    },
    async getEvents(code) {
      const work = await getWorkRow(code);
      if (!work) throw new Error("Không tìm thấy lệnh bảo trì.");
      const rows = await supabaseRequest("activity_logs", {
        query: queryString({ select: "id,event_type,details,created_by,created_at", maintenance_order_id: `eq.${work.id}`, order: "created_at.desc" }),
      });
      return rows.map((row) => ({ id: row.id, eventType: row.event_type, note: row.details, actor: row.created_by, createdAt: row.created_at }));
    },
    addEvent: async (code, note) => {
      const result = await rpc("cmms_add_work_event", { p_order_code: code, p_note: note });
      emitChange("works");
      return result;
    },
  };

  function createCollection(resource) {
    return {
      getAll: async () => {
        const rows = await supabaseRequest("devices", { query: queryString({ select: "*", order: "asset_code.asc" }) });
        return rows.map(mapItem);
      },
      add: async (item) => {
        const result = await supabaseRequest("devices", {
          method: "POST",
          prefer: "return=representation",
          body: { asset_code: item.code, name: item.name, location: item.location, purchase_date: item.date, status: item.status === "active" ? "Active" : item.status === "maintenance" ? "Maintenance" : "Inactive" },
        });
        emitChange(resource);
        return mapItem(result[0]);
      },
      update: async (code, item) => {
        const result = await supabaseRequest("devices", {
          method: "PATCH",
          query: queryString({ asset_code: `eq.${code}`, select: "*" }),
          prefer: "return=representation",
          body: { name: item.name, location: item.location, purchase_date: item.date, status: item.status === "active" ? "Active" : item.status === "maintenance" ? "Maintenance" : "Inactive" },
        });
        if (!result?.length) throw new Error("Không tìm thấy thiết bị.");
        emitChange(resource);
        return mapItem(result[0]);
      },
      remove: async (code) => {
        const result = await supabaseRequest("devices", {
          method: "PATCH",
          query: queryString({ asset_code: `eq.${code}`, select: "*" }),
          prefer: "return=representation",
          body: { status: "Inactive" },
        });
        if (!result?.length) throw new Error("Không tìm thấy thiết bị.");
        emitChange(resource);
      },
    };
  }

  const Materials = {
    async getByWork(code) {
      const work = await getWorkRow(code);
      if (!work) throw new Error("Không tìm thấy lệnh bảo trì.");
      const rows = await supabaseRequest("materials", {
        query: queryString({ select: "*", maintenance_order_id: `eq.${work.id}`, order: "created_at.asc" }),
      });
      return rows.map((row) => ({ id: row.id, workCode: code, code: row.item_code, name: row.item_name, staff: row.staff, qty: row.quantity, price: row.unit_price, addedAt: row.created_at }));
    },
    add: async (code, material) => {
      const result = await rpc("cmms_issue_material", { p_order_code: code, p_item_code: material.code, p_quantity: material.qty });
      emitChange("materials");
      emitChange("warehouse");
      return result;
    },
    remove: async (code, id) => {
      const rows = await supabaseRequest("materials", {
        query: queryString({ select: "id,maintenance_orders!inner(order_code)", id: `eq.${id}`, "maintenance_orders.order_code": `eq.${code}`, limit: "1" }),
      });
      if (!rows?.length) throw new Error("Không tìm thấy vật tư của lệnh.");
      await rpc("cmms_return_material", { p_material_id: id });
      emitChange("materials");
      emitChange("warehouse");
    },
  };

  const Warehouse = Object.assign(createCollection("warehouse"), {
    getAll: async () => {
      const rows = await supabaseRequest("warehouse_items", {
        query: queryString({ select: "*", is_active: "eq.true", order: "item_code.asc" }),
      });
      return rows.map(mapWarehouse);
    },
    add: async (item) => {
      const result = await rpc("cmms_create_warehouse_item", {
        p_item: { code: item.code, name: item.name, unit: item.unit, qty: item.qty, min: item.min, price: item.price },
      });
      emitChange("warehouse");
      return mapWarehouse(result);
    },
    update: async (code, item) => {
      const result = await supabaseRequest("warehouse_items", {
        method: "PATCH",
        query: queryString({ item_code: `eq.${code}`, select: "*" }),
        prefer: "return=representation",
        body: { name: item.name, unit: item.unit, min_stock_level: item.min, price: item.price },
      });
      if (!result?.length) throw new Error("Không tìm thấy vật tư.");
      emitChange("warehouse");
      return mapWarehouse(result[0]);
    },
    remove: async (code) => {
      await rpc("cmms_deactivate_warehouse_item", { p_item_code: code });
      emitChange("warehouse");
    },
    getMovements: async (limit = 100) => {
      const rows = await supabaseRequest("stock_movements", {
        query: queryString({ select: "*,warehouse_items!inner(item_code,name,unit),maintenance_orders(order_code)", order: "created_at.desc", limit: String(Math.min(Math.max(Number(limit) || 100, 1), 500)) }),
      });
      return rows.map((row) => ({
        id: row.id, warehouseCode: row.warehouse_items.item_code, itemName: row.warehouse_items.name,
        unit: row.warehouse_items.unit, workCode: row.maintenance_orders?.order_code || "",
        movementType: row.movement_type, delta: row.delta, qtyBefore: row.quantity_before,
        qtyAfter: row.quantity_after, unitPrice: row.unit_price, note: row.note,
        performedBy: row.performed_by, createdAt: row.created_at,
      }));
    },
    move: async (code, movement) => {
      const rows = await supabaseRequest("warehouse_items", {
        query: queryString({ select: "id", item_code: `eq.${code}`, is_active: "eq.true", limit: "1" }),
      });
      if (!rows?.length) throw new Error("Không tìm thấy vật tư đang hoạt động.");
      const result = await rpc("cmms_record_stock_movement", {
        p_item_id: rows[0].id,
        p_delta: movement.quantity,
        p_type: movement.type,
        p_note: movement.note,
        p_order_id: null,
      });
      emitChange("warehouse");
      emitChange("materials");
      return result;
    },
  });

  const Items = Object.assign(createCollection("items"), {
    async getHistory(code) {
      const devices = await supabaseRequest("devices", {
        query: queryString({ select: "id", asset_code: `eq.${code}`, limit: "1" }),
      });
      if (!devices?.length) throw new Error("Không tìm thấy thiết bị.");
      const orders = await supabaseRequest("maintenance_orders", {
        query: queryString({ select: "*,devices!maintenance_orders_device_id_fkey(asset_code,name)", device_id: `eq.${devices[0].id}`, order: "scheduled_date.desc" }),
      });
      return orders.map(mapWork);
    },
  });

  const Reports = {
    getSummary: () => rpc("cmms_report_summary"),
  };

  const Import = {
    run: (data) => rpc("cmms_import_local_data", { p_data: data }),
  };

  const Users = {
    async getAll() {
      const rows = await supabaseRequest("profiles", {
        query: queryString({ select: "id,email,full_name,role,is_active,created_at", order: "created_at.asc" }),
      });
      return rows.map((row) => ({ ...row, is_active: row.is_active ? 1 : 0 }));
    },
    add: async (user) => {
      const session = await getSession();
      const response = await fetch(`${API_URL}/functions/v1/admin-create-user`, {
        method: "POST",
        headers: {
          apikey: PUBLISHABLE_KEY,
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(user),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || result?.message || "Không thể tạo tài khoản.");
      emitChange("users");
      return result;
    },
    setActive: async (id, isActive) => {
      await rpc("cmms_set_user_status", { p_user_id: id, p_is_active: isActive });
      emitChange("users");
    },
  };

  const User = {
    get: async () => {
      const session = await getSession();
      if (!session) {
        redirectToLogin();
        throw new Error("Vui lòng đăng nhập để tiếp tục.");
      }
      const authUser = await authRequest("user", { token: session.access_token });
      const profiles = await supabaseRequest("profiles", {
        query: queryString({ select: "id,email,full_name,role,is_active", id: `eq.${authUser.id}`, limit: "1" }),
      });
      if (!profiles?.length || !profiles[0].is_active) {
        sessionStorage.removeItem(SESSION_KEY);
        currentUser = null;
        redirectToLogin();
        throw new Error("Tài khoản chưa được kích hoạt hoặc chưa có hồ sơ CMMS.");
      }
      currentUser = profiles[0];
      return currentUser;
    },
    logout: async () => {
      try {
        const session = await getSession();
        if (session) await authRequest("logout", { method: "POST", token: session.access_token });
      } finally {
        sessionStorage.removeItem(SESSION_KEY);
        currentUser = null;
      }
    },
    async changePassword(currentPassword, newPassword) {
      const session = await getSession();
      const email = session?.user?.email;
      if (!email) throw new Error("Không thể xác minh tài khoản hiện tại.");
      await authRequest("token?grant_type=password", { method: "POST", body: { email, password: currentPassword } });
      const result = await authRequest("user", {
        method: "PUT",
        token: session.access_token,
        body: { password: newPassword },
      });
      return result;
    },
    isLoggedIn: () => Boolean(currentUser),
  };

  async function migrateLegacyData(user) {
    clearLegacyAuthData();
    if (user.role !== "admin" || localStorage.getItem("myxtech_supabase_import_notice")) return;
    const legacyKeys = ["myxtech_works", "myxtech_items", "myxtech_warehouse"];
    const hasLegacyData = legacyKeys.some((key) => localStorage.getItem(key));
    if (!hasLegacyData) return;
    alert("Dữ liệu CMMS cũ trên trình duyệt vẫn được giữ nguyên. Hãy sao lưu và nhập bằng công cụ chuyển dữ liệu Supabase trước khi xóa dữ liệu cũ.");
    localStorage.setItem("myxtech_supabase_import_notice", "shown");
  }

  async function login(email, password) {
    const result = await authRequest("token?grant_type=password", {
      method: "POST",
      body: { email, password },
    });
    saveSession(result);
    currentUser = null;
    currentUser = await User.get();
    clearLegacyAuthData();
    return currentUser;
  }

  function mountUserMenu(user) {
    document.body.dataset.role = user.role;
    const name = document.getElementById("userName");
    const email = document.getElementById("userEmail");
    const avatar = document.getElementById("userAvatar");
    const displayName = user.full_name || user.email;
    if (name) name.textContent = displayName;
    if (email) email.textContent = user.email;
    if (avatar) {
      avatar.textContent = displayName.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
    }

    const topbar = document.querySelector(".topbar");
    if (topbar && !topbar.querySelector("[data-role-badge]")) {
      const badge = document.createElement("span");
      badge.className = "role-badge";
      badge.dataset.roleBadge = "";
      badge.textContent = user.role === "admin" ? "Quản trị viên" : "Kỹ thuật viên";
      badge.title = user.role === "admin"
        ? "Có quyền quản trị tài khoản, thiết bị và danh mục kho"
        : "Có quyền xử lý lệnh bảo trì và vật tư theo lệnh";
      topbar.append(badge);
    }

    if (!document.querySelector(".topbar #logoutBtn")) {
      const button = document.createElement("button");
      button.id = "logoutBtn";
      button.className = "session-action";
      button.type = "button";
      button.textContent = "Đăng xuất";
      button.addEventListener("click", async () => {
        try {
          await User.logout();
          location.replace(pageUrl("login.html"));
        } catch (error) {
          alert(error.message);
        }
      });
      document.querySelector(".topbar")?.append(button);
    }

    document.querySelectorAll("[data-admin-only]").forEach((element) => {
      element.hidden = user.role !== "admin";
    });
    mountApplicationNavigation(user);
  }

  function mountApplicationNavigation(user) {
    const currentPage = location.pathname.split("/").pop() || "dashboard.html";
    const isWorkList = currentPage === "dashboard.html" && location.hash === "#work-orders";
    const primaryLinks = [
      { href: "/dashboard.html", page: "dashboard.html", label: "Tổng quan", mobileLabel: "Tổng quan", icon: "fa-chart-pie", title: "Tình hình và chỉ số bảo trì" },
      { href: "/dashboard.html#work-orders", page: "work-orders", label: "Lệnh bảo trì", mobileLabel: "Lệnh", icon: "fa-list-check", title: "Tạo, theo dõi và xử lý lệnh bảo trì" },
      { href: "/items.html", page: "items.html", label: "Thiết bị", mobileLabel: "Thiết bị", icon: "fa-microchip", title: "Danh mục và tình trạng thiết bị" },
      { href: "/warehouse.html", page: "warehouse.html", label: "Kho vật tư", mobileLabel: "Kho", icon: "fa-boxes-stacked", title: "Tồn kho và giao dịch vật tư" },
      { href: "/reports.html", page: "reports.html", label: "Báo cáo", mobileLabel: "Báo cáo", icon: "fa-chart-column", title: "Thống kê hoạt động bảo trì và kho" },
    ];
    const accountLinks = [
      { href: "/account.html", page: "account.html", label: "Tài khoản của tôi", mobileLabel: "Tài khoản", icon: "fa-user-gear", title: "Đổi mật khẩu cá nhân" },
    ];
    if (user.role === "admin") {
      accountLinks.push({ href: "/users.html", page: "users.html", label: "Quản lý người dùng", mobileLabel: "Người dùng", icon: "fa-users", title: "Tạo tài khoản và quản lý quyền truy cập" });
      accountLinks.push({ href: "/supabase-import.html", page: "supabase-import.html", label: "Nhập dữ liệu cũ", mobileLabel: "Nhập dữ liệu", icon: "fa-file-import", title: "Nhập dữ liệu SQLite vào Supabase một lần" });
    }
    const allLinks = [...primaryLinks, ...accountLinks];
    const makeLink = (link, mobile = false) => {
      const anchor = document.createElement("a");
      anchor.href = pageUrl(link.href);
      anchor.className = "nav-item";
      anchor.title = link.title;
      const active = link.page === "work-orders"
        ? isWorkList || currentPage === "work-detail.html"
        : link.page === currentPage && !isWorkList;
      if (active) {
        anchor.classList.add("active");
        anchor.setAttribute("aria-current", "page");
      }
      const icon = document.createElement("i");
      icon.className = `fa-solid ${link.icon}`;
      icon.setAttribute("aria-hidden", "true");
      anchor.append(icon);
      if (mobile) {
        const label = document.createElement("span");
        label.textContent = link.mobileLabel;
        anchor.append(label);
      } else {
        anchor.append(document.createTextNode(` ${link.label}`));
      }
      return anchor;
    };

    document.querySelectorAll(".nav-menu").forEach((menu) => {
      menu.replaceChildren();
      const primaryHeading = document.createElement("div");
      primaryHeading.className = "nav-section-label";
      primaryHeading.textContent = "NGHIỆP VỤ";
      menu.append(primaryHeading, ...primaryLinks.map((link) => makeLink(link)));
      const accountHeading = document.createElement("div");
      accountHeading.className = "nav-section-label";
      accountHeading.textContent = "TÀI KHOẢN";
      menu.append(accountHeading, ...accountLinks.map((link) => makeLink(link)));
    });

    let nav = document.querySelector(".mobile-nav");
    if (!nav) {
      nav = document.createElement("nav");
      nav.className = "mobile-nav";
      nav.setAttribute("aria-label", "Điều hướng chính");
      document.body.append(nav);
    }
    nav.replaceChildren(...allLinks.map((link) => makeLink(link, true)));
    document.querySelectorAll('a[href^="/"]').forEach((anchor) => {
    const href = anchor.getAttribute("href");
    if (APP_BASE_PATH && href.startsWith(`${APP_BASE_PATH}/`)) return;
    anchor.href = pageUrl(href);
    });
  }

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-call]");
    if (!trigger) return;
    const action = trigger.dataset.call;
    const handler = action === "printPage" ? global.print : global[action];
    if (typeof handler !== "function") {
      alert("Thao tác này hiện không khả dụng.");
      return;
    }
    try {
      Promise.resolve(handler()).catch((error) => alert(error.message));
    } catch (error) {
      alert(error.message);
    }
  });

  document.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches('[data-call="signWork"]')) {
      event.preventDefault();
      global.signWork();
    }
  });

  function init() {
    if (initialization) return initialization;
    initialization = (async () => {
      currentUser = await User.get();
      await migrateLegacyData(currentUser);
      mountUserMenu(currentUser);
      return currentUser;
    })();
    return initialization;
  }

  global.MyxTech = {
    Works,
    Items,
    Warehouse,
    Materials,
    Reports,
    Import,
    Users,
    User,
    auth: { login },
    init,
    utils: {
      pageUrl,
      formatVND: (amount) => `${Number(amount || 0).toLocaleString("vi-VN")}đ`,
      today: () => {
        const date = new Date();
        date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
        return date.toISOString().slice(0, 10);
      },
      formatDate: (iso) => {
        if (!iso) return "";
        const [year, month, day] = iso.split("-");
        return `${day}/${month}/${year}`;
      },
      escapeHTML: (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]),
    },
  };
})(window);
