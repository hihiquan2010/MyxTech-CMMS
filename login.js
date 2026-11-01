"use strict";

const loginForm = document.getElementById("loginForm");
const loginButton = loginForm.querySelector('button[type="submit"]');
const loginMessage = document.getElementById("loginMessage");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  loginButton.textContent = "Đang xác thực...";
  loginMessage.textContent = "";
  loginMessage.classList.remove("is-error");

  try {
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    await MyxTech.auth.login(email, password);
    const requestedPage = new URLSearchParams(location.search).get("next") || "dashboard.html";
    const allowedPages = new Set(["dashboard.html", "items.html", "warehouse.html", "reports.html", "work-detail.html", "users.html", "account.html"]);
    location.replace(allowedPages.has(requestedPage) ? `/${requestedPage}` : "/dashboard.html");
  } catch (error) {
    loginMessage.textContent = error.message;
    loginMessage.classList.add("is-error");
    loginButton.disabled = false;
    loginButton.textContent = "Đăng nhập";
  }
});
