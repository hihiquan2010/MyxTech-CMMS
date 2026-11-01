<div align="center">

# 🛠️ MyxTech CMMS

**Hệ thống Quản lý Bảo trì Điện tử (Computerized Maintenance Management System)**

Xây dựng trên Node.js · Express · SQLite

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.5-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-Embedded-003B57?logo=sqlite&logoColor=white)](https://sqlite.org/)
[![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![License](https://img.shields.io/badge/License-Proprietary-red.svg)](#-giấy-phép)
[![Status](https://img.shields.io/badge/Status-Active-success.svg)]()

[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)]()
[![Security](https://img.shields.io/badge/Security-scrypt%20%2B%20HttpOnly-blue.svg)]()

</div>

---

## 📖 Giới thiệu

**MyxTech CMMS** là ứng dụng quản lý bảo trì thiết bị chạy trên nền **Node.js + Express + SQLite**. Toàn bộ dữ liệu được lưu trữ cục bộ trên máy chủ, phiên đăng nhập bảo mật bằng cookie `HttpOnly` — **không** lưu mật khẩu hay token trong `localStorage`.

> 🔒 **Mã nguồn độc quyền** — Xem mục [Giấy phép](#-giấy-phép).

---

## ✨ Tính năng chính

| Nhóm | Chức năng |
|---|---|
| 🧾 **Lệnh bảo trì** | Tạo lệnh từ Tổng quan, liên kết thiết bị, phân loại (phòng ngừa / khắc phục / kiểm tra), ngày dự kiến, mức ưu tiên, người phụ trách |
| 🔄 **Vòng đời lệnh** | Đã lên lịch → Đang thực hiện → Hoàn tất → Phê duyệt, có nhật ký đầy đủ |
| 📦 **Quản lý kho** | Nhập/xuất/điều chỉnh tồn có lý do, ghi sổ giao dịch trong cùng transaction SQLite, chặn tồn âm |
| 🧰 **Vật tư** | Chọn mã hàng đang hoạt động, hoàn trả khi xóa dòng, không sửa tồn trực tiếp từ form |
| 🏭 **Hồ sơ thiết bị** | Hiển thị lệnh bảo trì liên quan, trạng thái hoạt động / bảo trì / ngừng dùng |
| 📊 **Báo cáo** | Lệnh quá hạn, tồn thấp, giá trị kho, chi phí vật tư ròng — xuất CSV |
| 👥 **Người dùng** | Phân quyền Admin / Technician, kích hoạt/vô hiệu hóa, đổi mật khẩu, thu hồi phiên |
| 🔐 **Bảo mật** | Băm mật khẩu `scrypt`, cookie `HttpOnly`, rate limit đăng nhập, không lưu token client-side |
| 🗃️ **Migration** | Tự động migration idempotent khi khởi động, nhập dữ liệu cũ có kiểm tra phía server |

---

## 🧩 Yêu cầu hệ thống

| Thành phần | Phiên bản tối thiểu | Ghi chú |
|---|---|---|
| Node.js | **22.5+** | Cần module `node:sqlite` tích hợp sẵn |
| npm | 10+ | Đi kèm Node.js |
| OS | Windows / Linux / macOS | Không phụ thuộc hệ điều hành |

---

## 🚀 Cài đặt & Khởi chạy

```powershell
# 1. Cài dependencies
npm.cmd install

# 2. Khởi động server
npm.cmd start
```

Mở trình duyệt: **http://127.0.0.1:3000**

Cơ sở dữ liệu được tạo tự động tại:

```
data\myxtech.sqlite
```

---

## 👤 Tạo tài khoản quản trị đầu tiên

Trang đăng nhập: `/login.html`. **Không có tài khoản/mật khẩu mặc định.**

### 🔑 Tạo Admin

```powershell
node server.js --create-admin "admin@company.com" "Quản trị viên"
```

- Yêu cầu nhập mật khẩu **2 lần**
- Không hiển thị ký tự khi nhập
- Mật khẩu tối thiểu **12 ký tự**
- Băm bằng `scrypt` trước khi lưu

### 🔧 Tạo Kỹ thuật viên

```powershell
node server.js --create-user "tech@company.com" "Nguyễn Văn A" technician
```

### 📋 Quản lý người dùng

Sau khi đăng nhập Admin → **Quản lý người dùng**:
- Tạo tài khoản admin / kỹ thuật viên
- Kích hoạt / vô hiệu hóa tài khoản
- Đổi mật khẩu tại **Tài khoản của tôi**
- Đổi mật khẩu hoặc vô hiệu hóa sẽ **thu hồi các phiên khác**
- Không thể tự vô hiệu hóa hoặc vô hiệu hóa **admin cuối cùng**

---

## 🔐 Phân quyền

| Chức năng | 👑 Admin | 🔧 Technician |
|---|:---:|:---:|
| Sửa thiết bị | ✅ | ❌ |
| Tạo/điều chỉnh kho | ✅ | ❌ |
| Ngừng sử dụng vật tư | ✅ | ❌ |
| Xóa lệnh (chưa có giao dịch) | ✅ | ❌ |
| Phê duyệt lệnh | ✅ | ❌ |
| Quản lý người dùng | ✅ | ❌ |
| Quản lý lệnh | ✅ | ✅ |
| Bắt đầu / hoàn tất công việc | ✅ | ✅ |
| Xuất / hoàn trả vật tư (lệnh đang mở) | ✅ | ✅ |

---

## 🗄️ Cơ sở dữ liệu

### Bảng chính

| Bảng | Mục đích |
|---|---|
| `users` | Tài khoản, vai trò, mật khẩu đã băm |
| `assets` | Thiết bị |
| `work_orders` | Lệnh bảo trì |
| `maintenance_logs` | Nhật ký lệnh |
| `inventory_items` | Vật tư |
| `inventory_transactions` | Sổ giao dịch kho |

### Migration tự động

- Cột CMMS mới được bổ sung bằng migration **idempotent** khi server khởi động
- Tồn kho trước khi có sổ giao dịch → ghi nhận **tồn đầu kỳ một lần**
- Chênh lệch dữ liệu cũ → ghi thành **giao dịch riêng**, không ghi đè lịch sử

### Nhập dữ liệu trình duyệt cũ

Nếu admin đăng nhập trên trình duyệt còn dữ liệu cũ:
1. Ứng dụng **đề nghị nhập** dữ liệu vào SQLite
2. Server **kiểm tra lại** toàn bộ
3. Chỉ xóa dữ liệu trình duyệt **sau khi nhập thành công**
4. Muốn thử lại → xóa khóa `myxtech_migration_v1` trong browser storage

---

## 🌐 Triển khai

### ✅ Checklist trước khi lên production

- [ ] Đặt `NODE_ENV=production`
- [ ] Triển khai sau **HTTPS** (bật cookie `Secure` + HSTS)
- [ ] Đặt **reverse proxy** (Nginx/Caddy) phía trước
- [ ] **Không** public trực tiếp cổng Node.js (đang bind `127.0.0.1`)
- [ ] Giữ thư mục `data\` **riêng tư**
- [ ] Sao lưu `myxtech.sqlite` định kỳ
- [ ] **Không** commit database hoặc `.env` lên Git
- [ ] Nếu chạy nhiều instance → dùng kho chia sẻ cho rate limiting

### 📦 Cấu trúc thư mục

```
MyxTech-CMMS/
├── data/                    # ⚠️ KHÔNG commit — chứa myxtech.sqlite
│   └── myxtech.sqlite
├── test/                    # Test suite
├── server.js                # Entry point
├── data-manager.js          # Tầng dữ liệu
├── login.js
├── *.html                   # Giao diện
├── app.css
├── package.json
├── .env                     # ⚠️ KHÔNG commit
├── .gitignore
├── LICENSE
└── README.md
```

### 🛡️ `.gitignore` mẫu

```gitignore
node_modules/
data/*.sqlite
data/*.sqlite-wal
data/*.sqlite-shm
.env
.env.*
*.log
.DS_Store
Thumbs.db
.vscode/
```

---

## 🧪 Kiểm thử

```powershell
npm test
```

Bao gồm:
- `test/server.test.js` — API & server
- `test/migration.test.js` — migration & sổ giao dịch

---

## ❓ Câu hỏi thường gặp

<details>
<summary><b>Có cần cài SQLite server riêng không?</b></summary>

**Không.** Dự án dùng `node:sqlite` (module tích hợp của Node.js ≥ 22.5). Không cần cài MySQL/PostgreSQL/SQLite server.
</details>

<details>
<summary><b>Có deploy lên GitHub Pages được không?</b></summary>

**Không.** GitHub Pages chỉ phục vụ trang tĩnh, không chạy Node.js backend. Cần host hỗ trợ Node.js + ổ đĩa bền vững (Render, Railway, VPS…).
</details>

<details>
<summary><b>File database bị mất khi restart?</b></summary>

Trên dịch vụ cloud, cần gắn **persistent volume** (ổ đĩa bền vững) vào thư mục `data/`. Nếu không, container restart → mất DB.
</details>

<details>
<summary><b>Có thể chạy nhiều server cùng lúc không?</b></summary>

SQLite phù hợp với **một instance**. Nếu cần scale ngang → chuyển sang **PostgreSQL**.
</details>

<details>
<summary><b>Quên mật khẩu admin thì sao?</b></summary>

Dừng server, chạy lại lệnh `--create-admin` với email mới, hoặc thao tác trực tiếp trên SQLite (xóa/cập nhật bảng `users`).
</details>

---

## 📜 Giấy phép

**Copyright © 2025 MyxTech. All rights reserved.**

Phần mềm này là **tài sản độc quyền** của MyxTech. **Không phải phần mềm mã nguồn mở.**

- ❌ Không được sao chép, phân phối, chỉnh sửa, hoặc sử dụng thương mại khi chưa có **văn bản cho phép**.
- ❌ Không được tái sử dụng mã nguồn cho dự án khác.
- ✅ Chỉ được sử dụng cho mục đích nội bộ của MyxTech hoặc theo hợp đồng đã ký.

Xem chi tiết tại file [LICENSE](./LICENSE).

Liên hệ cấp phép: **uyp079658@gmail.com**

---

<div align="center">

**MyxTech CMMS** — Được xây dựng với ❤️ cho công tác bảo trì chuyên nghiệp.

[⬆ Về đầu trang](#️-myxtech-cmms)

</div>
