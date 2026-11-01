(function (global) {
  "use strict";

  let csrfToken = "";
  let currentUser = null;
  let initialization;

  async function readJsonResponse(response) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("json")) {
      throw new Error("API không trả về JSON. Hãy kiểm tra backend Node.js đang chạy và website đang trỏ đúng máy chủ.");
    }
    try {
      return await response.json();
    } catch {
      throw new Error("Máy chủ trả về JSON không hợp lệ.");
    }
  }

  async function getCsrfToken() {
    if (csrfToken) return csrfToken;
    const response = await fetch("/api/auth/csrf", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const body = await readJsonResponse(response);
    if (!response.ok) throw new Error(body.error || "Không thể khởi tạo phiên bảo mật.");
    csrfToken = body.csrfToken;
    return csrfToken;
  }

  async function request(path, { method = "GET", body } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (path.startsWith("/api/")) {
      headers["X-CSRF-Token"] = await getCsrfToken();
    }

    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401 && !path.startsWith("/api/auth/login")) {
      const next = encodeURIComponent(`${location.pathname.split("/").pop()}${location.search}`);
      location.replace(`/login.html?next=${next}`);
      throw new Error("Phiên đăng nhập đã hết hạn.");
    }

    if (response.status === 204) return null;
    const result = await readJsonResponse(response);
    if (!response.ok) {
      if (response.status === 403 && result.error?.includes("Phiên bảo mật")) {
        csrfToken = "";
      }
      const error = new Error(result.error || "Yêu cầu không thành công.");
      error.status = response.status;
      throw error;
    }
    return result;
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
      return request("/api/works");
    },
    async getById(code) {
      try {
        return await request(`/api/works/${encodeURIComponent(code)}`);
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
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
      const result = await request("/api/works", { method: "POST", body: work });
      emitChange("works");
      return result;
    },
    async update(code, updates) {
      const current = await this.getById(code);
      if (!current) throw new Error("Không tìm thấy công việc.");
      const result = await request(`/api/works/${encodeURIComponent(code)}`, {
        method: "PUT",
        body: { ...current, ...updates },
      });
      emitChange("works");
      return result;
    },
    async remove(code) {
      const result = await request(`/api/works/${encodeURIComponent(code)}`, { method: "DELETE" });
      emitChange("works");
      return result;
    },
    async approve(code) {
      const result = await request(`/api/works/${encodeURIComponent(code)}/approve`, { method: "POST", body: {} });
      emitChange("works");
      return result;
    },
    async start(code) {
      const result = await request(`/api/works/${encodeURIComponent(code)}/start`, { method: "POST", body: {} });
      emitChange("works");
      emitChange("items");
      return result;
    },
    async complete(code) {
      const result = await request(`/api/works/${encodeURIComponent(code)}/complete`, { method: "POST", body: {} });
      emitChange("works");
      emitChange("items");
      return result;
    },
    getEvents: (code) => request(`/api/works/${encodeURIComponent(code)}/events`),
    addEvent: async (code, note) => {
      const result = await request(`/api/works/${encodeURIComponent(code)}/events`, { method: "POST", body: { note } });
      emitChange("works");
      return result;
    },
  };

  function createCollection(resource) {
    return {
      getAll: () => request(`/api/${resource}`),
      add: async (item) => {
        const result = await request(`/api/${resource}`, { method: "POST", body: item });
        emitChange(resource);
        return result;
      },
      update: async (code, item) => {
        const result = await request(`/api/${resource}/${encodeURIComponent(code)}`, { method: "PUT", body: item });
        emitChange(resource);
        return result;
      },
      remove: async (code) => {
        const result = await request(`/api/${resource}/${encodeURIComponent(code)}`, { method: "DELETE" });
        emitChange(resource);
        return result;
      },
    };
  }

  const Materials = {
    getByWork: (code) => request(`/api/works/${encodeURIComponent(code)}/materials`),
    add: async (code, material) => {
      const result = await request(`/api/works/${encodeURIComponent(code)}/materials`, { method: "POST", body: material });
      emitChange("materials");
      return result;
    },
    remove: async (code, id) => {
      const result = await request(`/api/works/${encodeURIComponent(code)}/materials/${encodeURIComponent(id)}`, { method: "DELETE" });
      emitChange("materials");
      return result;
    },
  };

  const Warehouse = Object.assign(createCollection("warehouse"), {
    getMovements: (limit = 100) => request(`/api/warehouse/movements?limit=${encodeURIComponent(limit)}`),
    move: async (code, movement) => {
      const result = await request(`/api/warehouse/${encodeURIComponent(code)}/movements`, {
        method: "POST",
        body: movement,
      });
      emitChange("warehouse");
      emitChange("materials");
      return result;
    },
  });

  const Items = Object.assign(createCollection("items"), {
    getHistory: (code) => request(`/api/items/${encodeURIComponent(code)}/history`),
  });

  const Reports = {
    getSummary: () => request("/api/reports/summary"),
  };

  const Users = {
    getAll: () => request("/api/users"),
    add: async (user) => {
      const result = await request("/api/users", { method: "POST", body: user });
      emitChange("users");
      return result;
    },
    setActive: async (id, isActive) => {
      const result = await request(`/api/users/${encodeURIComponent(id)}/status`, {
        method: "PATCH",
        body: { is_active: isActive },
      });
      emitChange("users");
      return result;
    },
  };

  const User = {
    get: async () => {
      currentUser = await request("/api/auth/me");
      return currentUser;
    },
    logout: async () => {
      await request("/api/auth/logout", { method: "POST", body: {} });
      currentUser = null;
    },
    changePassword: (currentPassword, newPassword) => request("/api/auth/password", {
      method: "POST",
      body: { currentPassword, newPassword },
    }),
    isLoggedIn: () => Boolean(currentUser),
  };

  async function migrateLegacyData(user) {
    let payload;
    let materialKeys = [];
    try {
      if (localStorage.getItem("myxtech_migration_v1")) return;
      const readArray = (key) => {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        const value = JSON.parse(raw);
        if (!Array.isArray(value)) throw new Error(`Dữ liệu cũ "${key}" không đúng định dạng.`);
        return value;
      };
      payload = {
        works: readArray("myxtech_works"),
        items: readArray("myxtech_items"),
        warehouse: readArray("myxtech_warehouse"),
        materials: [],
      };
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key?.startsWith("myxtech_materials_")) continue;
        const entries = readArray(key);
        const workCode = key.slice("myxtech_materials_".length);
        payload.materials.push(...entries.map((entry) => ({ ...entry, workCode })));
        materialKeys.push(key);
      }
    } catch (error) {
      alert(`Không thể đọc dữ liệu cũ trên trình duyệt: ${error.message}`);
      return;
    }

    clearLegacyAuthData();
    const total = payload.works.length + payload.items.length + payload.warehouse.length + payload.materials.length;
    if (user.role !== "admin" || total === 0) return;
    const accepted = confirm(
      `Tìm thấy dữ liệu CMMS cũ trên trình duyệt (${payload.works.length} công việc, ${payload.items.length} thiết bị, ${payload.warehouse.length} vật tư kho, ${payload.materials.length} vật tư sử dụng). Nhập và cập nhật các bản ghi trùng mã vào cơ sở dữ liệu máy chủ?`,
    );
    if (!accepted) {
      localStorage.setItem("myxtech_migration_v1", "dismissed");
      return;
    }

    let result;
    try {
      result = await request("/api/migration/local", { method: "POST", body: payload });
    } catch (error) {
      alert(`Không thể nhập dữ liệu cũ; dữ liệu trên trình duyệt vẫn được giữ nguyên. ${error.message}`);
      return;
    }
    try {
      localStorage.setItem("myxtech_migration_v1", "done");
      ["myxtech_works", "myxtech_items", "myxtech_warehouse", ...materialKeys].forEach((key) => localStorage.removeItem(key));
      alert(`Đã nhập dữ liệu cũ: ${result.imported.works} công việc, ${result.imported.items} thiết bị, ${result.imported.warehouse} vật tư kho, ${result.imported.materials} vật tư sử dụng.`);
    } catch (error) {
      console.warn("Không thể xóa hết bản sao dữ liệu cũ trên trình duyệt.", error);
      alert("Dữ liệu đã được nhập vào máy chủ, nhưng không thể xóa bản sao cũ khỏi trình duyệt.");
    }
  }

  async function login(email, password) {
    await getCsrfToken();
    const result = await request("/api/auth/login", {
      method: "POST",
      body: { email, password },
    });
    csrfToken = result.csrfToken;
    currentUser = result.user;
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
          location.replace("/login.html");
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
    }
    const allLinks = [...primaryLinks, ...accountLinks];
    const makeLink = (link, mobile = false) => {
      const anchor = document.createElement("a");
      anchor.href = link.href;
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
      await getCsrfToken();
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
    Users,
    User,
    auth: { login },
    init,
    utils: {
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
