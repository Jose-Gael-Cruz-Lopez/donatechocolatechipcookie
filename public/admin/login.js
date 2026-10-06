const form = document.querySelector("#login-form");
const password = document.querySelector("#password");
const showPassword = document.querySelector("#show-password");
const submit = document.querySelector("#login-submit");
const label = document.querySelector("#login-label");
const errorMessage = document.querySelector("#login-error");
const status = document.querySelector("#login-status");
let signingIn = false;

showPassword.addEventListener("click", () => {
  const show = password.type === "password";
  password.type = show ? "text" : "password";
  showPassword.textContent = show ? "Hide" : "Show";
  showPassword.setAttribute("aria-pressed", String(show));
  showPassword.setAttribute(
    "aria-label",
    show ? "Hide admin password" : "Show admin password",
  );
});

password.addEventListener("input", () => {
  errorMessage.hidden = true;
  password.removeAttribute("aria-invalid");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (signingIn || !form.reportValidity()) return;
  signingIn = true;
  submit.disabled = true;
  showPassword.disabled = true;
  label.textContent = "Signing in…";
  status.textContent = "Checking your password.";
  errorMessage.hidden = true;
  password.removeAttribute("aria-invalid");
  form.setAttribute("aria-busy", "true");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ password: password.value }),
      signal: controller.signal,
    });
    let result;
    try {
      result = await response.json();
    } catch (error) {
      if (error.name === "AbortError") throw error;
    }
    if (!response.ok || result?.ok !== true) {
      if (response.status === 401) {
        password.value = "";
        password.setAttribute("aria-invalid", "true");
      }
      throw new Error(
        typeof result?.error === "string"
          ? result.error
          : response.status === 401
            ? "That password wasn’t accepted. Please try again."
            : response.status === 429
              ? "Too many attempts. Please wait a few minutes before trying again."
              : "We couldn’t sign you in. Please try again.",
      );
    }
    password.value = "";
    status.textContent = "Signed in. Opening the guest list…";
    window.location.replace("/admin/");
  } catch (error) {
    errorMessage.textContent =
      error.name === "AbortError"
        ? "That took too long. Please try again."
        : error instanceof TypeError
          ? "We couldn’t connect. Check your connection and try again."
          : error.message;
    errorMessage.hidden = false;
    status.textContent = "";
    password.focus();
  } finally {
    clearTimeout(timeout);
    signingIn = false;
    submit.disabled = false;
    showPassword.disabled = false;
    label.textContent = "Open the guest list";
    form.removeAttribute("aria-busy");
  }
});

// An active session can go straight to your dashboard.
async function checkSession() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch("/api/admin/session", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.ok) {
      const result = await response.json();
      if (result?.ok === true && !signingIn) window.location.replace("/admin/");
    }
  } catch {
    // Leave the form available if the optional session check cannot connect.
  } finally {
    clearTimeout(timeout);
  }
}

checkSession();
