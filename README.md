# Deploy Web Lên Internet Không Cần GitHub Hay Bên Thứ Ba

Hướng dẫn tổng hợp các cách đưa website lên internet mà **không phụ thuộc vào GitHub, Vercel, Netlify** hay các nền tảng deploy trung gian. Bạn sẽ tự quản lý không gian lưu trữ và chương trình phục vụ website của mình.

## Mục lục

- [1. Tự host trên máy tính cá nhân](#1-tự-host-trên-máy-tính-cá-nhân)
- [2. Thuê VPS và tự cấu hình](#2-thuê-vps-và-tự-cấu-hình)
- [3. Sử dụng Docker để đóng gói và deploy](#3-sử-dụng-docker-để-đóng-gói-và-deploy)
- [4. Tóm tắt và lựa chọn](#4-tóm-tắt-và-lựa-chọn)
- [Giấy phép](#giấy-phép)
- [Liên hệ](#liên-hệ)

---

## 1. Tự host trên máy tính cá nhân

Phù hợp cho nhu cầu nhỏ, thử nghiệm hoặc chia sẻ nội bộ. Bạn biến laptop/PC của mình thành web server.

### Công cụ gợi ý

- **HomeHost**: Công cụ dòng lệnh mã nguồn mở giúp biến laptop thành web server nhanh chóng. Tự động phát hiện loại dự án, cấu hình Caddy và có thể tạo tunnel miễn phí.

  ```bash
  pip install homehost
  homehost serve . --public
  ```

- **html-golive**: Cho phép publish file HTML hoặc thư mục dự án thành URL có thể chia sẻ, chạy trên máy cá nhân, NAS hoặc VPS nội bộ.

### Hạn chế

- Máy tính phải bật 24/7.
- Cấu hình mạng gia đình có thể phức tạp nếu muốn truy cập công khai ổn định (port forwarding, IP tĩnh).

---

## 2. Thuê VPS và tự cấu hình

Đây là giải pháp tự chủ và ổn định nhất. Bạn thuê VPS từ nhà cung cấp hạ tầng như DigitalOcean, Vultr, Hostease... và tự cài đặt mọi thứ.

### Quy trình cơ bản

1. **Chọn và kết nối VPS**
   - Thuê VPS (khuyến nghị Ubuntu 22.04 LTS cho người mới).
   - Kết nối qua SSH bằng Terminal, PuTTY hoặc công cụ tương tự.

2. **Cài đặt web server**
   - Cài **Nginx** hoặc **Apache**.
   - Với website động (WordPress, Laravel...), có thể cài bộ **LEMP** (Linux, Nginx, MySQL, PHP).
   - Với trang tĩnh (HTML/CSS/JS), chỉ cần Nginx là đủ.

3. **Đưa code lên server**
   - Dùng `scp` để copy trực tiếp thư mục code từ máy tính lên VPS.
   - Hoặc dùng các công cụ CLI chuyên dụng.

4. **Trỏ tên miền và cài SSL**
   - Trỏ bản ghi A của tên miền về IP VPS.
   - Cài chứng chỉ SSL miễn phí từ Let's Encrypt để chạy `https://`.

### Công cụ hỗ trợ

- **sitedrop**: Cài trên cả VPS và máy cá nhân. Sau đó upload file HTML để có URL công khai do VPS của bạn phục vụ.

  ```bash
  sitedrop upload portfolio.html
  ```

- **djevops**: Công cụ deploy ứng dụng **Django** lên VPS Linux (Ubuntu/Debian) nhanh chóng, cần quyền SSH root.

---

## 3. Sử dụng Docker để đóng gói và deploy

Docker giúp đóng gói ứng dụng và môi trường chạy vào container, đảm bảo môi trường nhất quán trên mọi VPS có cài Docker.

### Quy trình thường dùng

1. **Build locally**

   ```bash
   docker build -t my-site .
   ```

2. **Upload lên VPS**

   ```bash
   scp -r ./my-project user@your-vps-ip:/var/www/
   ```

3. **Chạy container trên VPS**

   ```bash
   docker run -d -p 3000:3000 my-site
   ```

4. **Cấu hình Nginx làm reverse proxy**
   - Nginx nhận request từ cổng 80/443.
   - Chuyển tiếp vào container đang chạy ở cổng nội bộ, ví dụ `3000`.

---

## 4. Tóm tắt và lựa chọn

| Phương pháp | Phù hợp với | Ưu điểm | Lưu ý |
| :--- | :--- | :--- | :--- |
| **Tự host trên máy cá nhân** | Thử nghiệm, chia sẻ nội bộ, dự án siêu nhỏ | Miễn phí, không cần thuê VPS, kiểm soát tuyệt đối | Máy phải bật 24/7, cấu hình mạng phức tạp nếu muốn truy cập công khai ổn định |
| **Thuê VPS và tự cấu hình** | Website cá nhân, blog, ứng dụng web cần ổn định | Toàn quyền kiểm soát, hiệu năng tốt, IP tĩnh, phù hợp gắn tên miền riêng | Cần kiến thức cơ bản về Linux và quản trị server |
| **Docker trên VPS** | Ứng dụng hiện đại, cần môi trường nhất quán | Linh hoạt, dễ nâng cấp, cô lập ứng dụng, dễ di chuyển giữa các VPS | Cần làm quen với Docker, cần thêm bước cấu hình Nginx làm reverse proxy |

> **Kết luận:** Để thoát khỏi sự phụ thuộc vào GitHub và các nền tảng deploy, thuê VPS và tự cấu hình web server (Nginx) là con đường chuẩn mực và bền vững nhất. Bạn có thể bắt đầu với hướng dẫn LEMP cơ bản, sau đó nâng cấp lên Docker nếu cần.

---

## Giấy phép

Dự án này được phân phối theo giấy phép được quy định trong file [LICENSE](./LICENSE). Vui lòng đọc kỹ các điều khoản trước khi sử dụng, sao chép hoặc phân phối lại.

## Liên hệ

Nếu có câu hỏi, góp ý hoặc cần hỗ trợ, vui lòng liên hệ:

- **Email:** [uyp079658@gmail.com](mailto:uyp079658@gmail.com)

---

© 2026. Nội dung được tổng hợp và chia sẻ nhằm mục đích tham khảo.
