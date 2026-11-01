(function (global) {
  "use strict";

  let csrfToken = "";
  let currentUser = null;
  let initialization;

  async function getCsrfToken() {
    if (csrfToken) return csrfToken;
    const response = await fetch("/api/auth/csrf", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const body = await response.json();
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
    const result = await response.json();
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

    if (!document.getElementById("logoutBtn")) {
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
    document.querySelectorAll(".nav-menu").forEach((menu) => {
      if (!menu.querySelector('[data-account-link]')) {
        const accountLink = document.createElement("a");
        accountLink.href = "/account.html";
        accountLink.className = "nav-item";
        accountLink.dataset.accountLink = "";
        accountLink.innerHTML = '<i class="fa-solid fa-user-gear"></i> Tài khoản của tôi';
        menu.append(accountLink);
      }
      if (user.role === "admin" && !menu.querySelector('[data-user-management-link]')) {
        const link = document.createElement("a");
        link.href = "/users.html";
        link.className = "nav-item";
        link.dataset.userManagementLink = "";
        link.innerHTML = '<i class="fa-solid fa-users"></i> Quản lý người dùng';
        menu.append(link);
      }
    });
  }

  function mountMobileNavigation() {
    if (document.querySelector(".mobile-nav")) return;
    const currentPage = location.pathname.split("/").pop();
    const links = [
      ["dashboard.html", "Tổng quan", "fa-chart-pie"],
      ["items.html", "Thiết bị", "fa-microchip"],
      ["warehouse.html", "Kho", "fa-boxes-stacked"],
      ["reports.html", "Báo cáo", "fa-chart-column"],
      ["account.html", "Tài khoản", "fa-user-gear"],
    ];
    if (currentUser?.role === "admin") links.push(["users.html", "Người dùng", "fa-users"]);
    const nav = document.createElement("nav");
    nav.className = "mobile-nav";
    nav.setAttribute("aria-label", "Điều hướng chính");
    nav.innerHTML = links.map(([href, label, icon]) =>
      `<a href="/${href}"${currentPage === href ? ' aria-current="page"' : ""}><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${label}</span></a>`,
    ).join("");
    document.body.append(nav);
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
      mountMobileNavigation();
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
