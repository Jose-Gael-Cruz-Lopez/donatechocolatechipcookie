const elements = {
  account: document.querySelector("#account-email"),
  logout: document.querySelector("#logout"),
  total: document.querySelector("#stat-total"),
  today: document.querySelector("#stat-today"),
  schools: document.querySelector("#stat-schools"),
  refresh: document.querySelector("#refresh"),
  export: document.querySelector("#export"),
  searchForm: document.querySelector("#search-form"),
  search: document.querySelector("#search"),
  clear: document.querySelector("#clear-search"),
  error: document.querySelector("#admin-error"),
  actionStatus: document.querySelector("#action-status"),
  results: document.querySelector("#results"),
  listState: document.querySelector("#list-state"),
  stateTitle: document.querySelector("#state-title"),
  stateCopy: document.querySelector("#state-copy"),
  table: document.querySelector("#registrations-table"),
  rows: document.querySelector("#registration-rows"),
  count: document.querySelector("#result-count"),
  previous: document.querySelector("#previous"),
  next: document.querySelector("#next"),
  position: document.querySelector("#page-position"),
  updated: document.querySelector("#last-updated"),
};

const numbers = new Intl.NumberFormat();
const joinedDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const state = {
  page: 1,
  pageSize: 25,
  total: 0,
  totalPages: 1,
  search: "",
  loading: true,
  loaded: false,
  sessionReady: false,
  exporting: false,
  loggingOut: false,
};

// Session cookies stay with the browser; the CSRF token lives only in this page.
let csrfToken = "";
let searchTimer;
let listController;
let listRequest = 0;
let redirecting = false;

class SessionExpired extends Error {}

function goToLogin() {
  if (redirecting) return;
  redirecting = true;
  listController?.abort();
  state.sessionReady = false;
  csrfToken = "";
  elements.rows.replaceChildren();
  elements.table.hidden = true;
  window.location.replace("/admin/login");
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, options.csv ? 30000 : 15000);

  try {
    const response = await fetch(path, {
      method: options.method || "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: options.csv ? "text/csv" : "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      body: options.body,
      signal: controller.signal,
    });
    if (response.status === 401) {
      goToLogin();
      throw new SessionExpired();
    }
    if (options.csv && response.ok) {
      if (!response.headers.get("Content-Type")?.includes("text/csv")) {
        throw new Error("The export was not available. Please try again.");
      }
      return await response.blob();
    }
    let result;
    try {
      result = await response.json();
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new Error(
        "The server returned an unexpected response. Please try again.",
      );
    }
    if (!response.ok || result?.ok !== true) {
      throw new Error(
        typeof result?.error === "string"
          ? result.error
          : "The request could not be completed. Please try again.",
      );
    }
    return result;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function errorText(error) {
  if (error.name === "AbortError") {
    return "The request took too long. Please try again.";
  }
  if (error instanceof TypeError) {
    return "We couldn’t connect. Check your connection and try again.";
  }
  return error.message || "Something went wrong. Please try again.";
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
}

function clearError() {
  elements.error.hidden = true;
  elements.error.textContent = "";
}

function showState(title, copy) {
  elements.table.hidden = true;
  elements.listState.hidden = false;
  elements.stateTitle.textContent = title;
  elements.stateCopy.textContent = copy;
}

function controls() {
  elements.refresh.disabled = state.loading || state.loggingOut;
  elements.logout.disabled = !state.sessionReady || state.loggingOut;
  elements.export.disabled =
    !state.loaded ||
    state.loading ||
    state.exporting ||
    state.loggingOut ||
    Boolean(searchTimer) ||
    state.total === 0;
  elements.previous.disabled =
    !state.loaded || state.loading || state.loggingOut || state.page <= 1;
  elements.next.disabled =
    !state.loaded ||
    state.loading ||
    state.loggingOut ||
    state.page >= state.totalPages;
  elements.clear.hidden = elements.search.value.length === 0;
}

function display(value) {
  return value === null || value === undefined || value === ""
    ? "—"
    : String(value);
}

function cell(label, value, className = "") {
  const td = document.createElement("td");
  td.dataset.label = label;
  const content = document.createElement("span");
  content.className = ["cell-value", className].filter(Boolean).join(" ");
  content.textContent = display(value);
  td.append(content);
  return td;
}

function row(registration) {
  const tr = document.createElement("tr");
  const name = cell("Name", "");
  const wrapper = name.firstElementChild;
  wrapper.textContent = "";
  const person = document.createElement("span");
  person.className = "member-name";
  person.textContent = display(registration.name);
  const id = document.createElement("span");
  id.className = "member-id";
  id.textContent = `#${display(registration.id)}`;
  wrapper.append(person, id);
  tr.append(
    name,
    cell("Email", registration.email),
    cell("School", registration.school),
    cell("Grade / year", registration.grade),
    cell("Fun fact", registration.fun_fact, "fun-fact"),
  );
  const date = new Date(registration.created_at);
  const dateCell = cell("Joined (UTC)", "—", "joined-date");
  if (!Number.isNaN(date.getTime())) {
    const time = document.createElement("time");
    time.dateTime = date.toISOString();
    time.title = `${joinedDate.format(date)} UTC`;
    time.textContent = joinedDate.format(date);
    dateCell.firstElementChild.replaceChildren(time);
  }
  tr.append(dateCell);
  return tr;
}

function render(result) {
  if (
    !Array.isArray(result.registrations) ||
    !Number.isInteger(result.total) ||
    result.total < 0 ||
    !Number.isInteger(result.page) ||
    result.page < 1 ||
    !Number.isInteger(result.pageSize) ||
    result.pageSize < 1 ||
    !Number.isInteger(result.totalPages) ||
    result.totalPages < 0 ||
    !result.stats ||
    ![result.stats.total, result.stats.today, result.stats.schools].every(
      (number) => Number.isInteger(number) && number >= 0,
    )
  ) {
    throw new Error(
      "The guest list could not be read. Please refresh and try again.",
    );
  }

  state.page = result.page;
  state.pageSize = result.pageSize;
  state.total = result.total;
  state.totalPages = Math.max(1, result.totalPages);
  const fragment = document.createDocumentFragment();
  for (const registration of result.registrations)
    fragment.append(row(registration));
  elements.rows.replaceChildren(fragment);
  elements.total.textContent = numbers.format(result.stats.total);
  elements.today.textContent = numbers.format(result.stats.today);
  elements.schools.textContent = numbers.format(result.stats.schools);

  if (result.registrations.length > 0) {
    elements.listState.hidden = true;
    elements.table.hidden = false;
    const first = (state.page - 1) * state.pageSize + 1;
    const last = first + result.registrations.length - 1;
    elements.count.textContent =
      `${numbers.format(first)}–${numbers.format(last)} of ` +
      `${numbers.format(state.total)} ${state.search ? "matches" : "registrations"}`;
  } else {
    showState(
      state.search
        ? "No matches this time."
        : "The first hello is still to come.",
      state.search
        ? `No registrations match “${state.search}”. Try another name, email, school, year, or fun fact.`
        : "New registrations will appear here when someone joins through the invitation.",
    );
    elements.count.textContent = state.search ? "0 matches" : "0 registrations";
  }
  elements.position.textContent = state.total
    ? `Page ${state.page} of ${numbers.format(state.totalPages)}`
    : "No pages yet";
  const updated = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
  elements.updated.textContent = `Updated ${updated}`;
  state.loaded = true;
}

async function loadRegistrations() {
  if (!state.sessionReady || redirecting) return;
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  const requestId = ++listRequest;
  state.loading = true;
  state.loaded = false;
  clearError();
  elements.results.setAttribute("aria-busy", "true");
  elements.count.textContent = "Loading registrations…";
  showState("A moment, please.", "Loading the guest list.");
  controls();

  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
  });
  if (state.search) params.set("search", state.search);
  try {
    const result = await request(`/api/admin/registrations?${params}`, {
      signal: controller.signal,
    });
    if (requestId !== listRequest) return;
    render(result);
  } catch (error) {
    if (requestId !== listRequest || controller.signal.aborted) return;
    if (error instanceof SessionExpired) return;
    showError(errorText(error));
    showState("The list couldn’t be loaded.", "Use Refresh to try again.");
    elements.count.textContent = "Registrations unavailable";
    elements.position.textContent = "—";
  } finally {
    if (requestId === listRequest) {
      state.loading = false;
      elements.results.setAttribute("aria-busy", "false");
      controls();
    }
  }
}

async function start() {
  state.loading = true;
  controls();
  clearError();
  showState("Opening the guest list…", "Checking your session.");
  try {
    const session = await request("/api/admin/session");
    if (typeof session.csrfToken !== "string" || !session.csrfToken) {
      throw new Error("Your session could not be verified. Please refresh.");
    }
    csrfToken = session.csrfToken;
    elements.account.textContent = display(session.email);
    state.sessionReady = true;
    state.search = elements.search.value.trim();
    await loadRegistrations();
  } catch (error) {
    if (error instanceof SessionExpired) return;
    state.loading = false;
    elements.results.setAttribute("aria-busy", "false");
    elements.account.textContent = "Session unavailable";
    showError(errorText(error));
    showState(
      "We couldn’t open the guest list.",
      "Use Refresh to check your session again.",
    );
    elements.count.textContent = "Session unavailable";
    controls();
  }
}

function search() {
  clearTimeout(searchTimer);
  searchTimer = undefined;
  state.search = elements.search.value.trim();
  state.page = 1;
  controls();
  loadRegistrations();
}

elements.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  search();
});
elements.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 300);
  controls();
});
elements.clear.addEventListener("click", () => {
  elements.search.value = "";
  search();
  elements.search.focus();
});
elements.refresh.addEventListener("click", () => {
  clearTimeout(searchTimer);
  searchTimer = undefined;
  const query = elements.search.value.trim();
  if (query !== state.search) state.page = 1;
  state.search = query;
  state.sessionReady ? loadRegistrations() : start();
});
elements.previous.addEventListener("click", () => {
  if (state.loading || state.page <= 1) return;
  state.page -= 1;
  loadRegistrations();
});
elements.next.addEventListener("click", () => {
  if (state.loading || state.page >= state.totalPages) return;
  state.page += 1;
  loadRegistrations();
});

elements.export.addEventListener("click", async () => {
  if (state.exporting || !state.loaded) return;
  state.exporting = true;
  clearError();
  elements.actionStatus.textContent = "Preparing the CSV export…";
  controls();
  const exportedSearch = state.search;
  const params = new URLSearchParams();
  if (exportedSearch) params.set("search", exportedSearch);
  try {
    const blob = await request(
      `/api/admin/export${params.size ? `?${params}` : ""}`,
      {
        csv: true,
      },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download =
      `cookie-registrations${exportedSearch ? "-filtered" : ""}-` +
      `${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    elements.actionStatus.textContent =
      "Your CSV export is ready. Check your downloads.";
  } catch (error) {
    if (error instanceof SessionExpired) return;
    showError(errorText(error));
    elements.actionStatus.textContent = "Export failed.";
  } finally {
    state.exporting = false;
    controls();
  }
});

elements.logout.addEventListener("click", async () => {
  if (state.loggingOut || !state.sessionReady) return;
  state.loggingOut = true;
  clearError();
  elements.logout.textContent = "Logging out…";
  controls();
  try {
    await request("/api/admin/logout", {
      method: "POST",
      body: "{}",
      headers: { "X-CSRF-Token": csrfToken },
    });
    csrfToken = "";
    goToLogin();
  } catch (error) {
    if (error instanceof SessionExpired) return;
    showError(errorText(error));
    state.loggingOut = false;
    elements.logout.textContent = "Log out ↗";
    controls();
  }
});

// Do not restore an old guest list from the back/forward cache after logout.
window.addEventListener("pagehide", () => {
  elements.rows.replaceChildren();
  elements.table.hidden = true;
  state.loaded = false;
  state.sessionReady = false;
  csrfToken = "";
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) start();
});

start();
