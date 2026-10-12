// A deliberately thin client: it fetches and renders, and holds nothing. Every
// fact on screen came from the API, which means a passing browser check is not
// evidence that the API works - it is only evidence that this page drew what
// the API sent.
const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem("token") || "";

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), ...(token ? { authorization: "Bearer " + token } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function money(order) {
  return (order.amountCents / 100).toFixed(2) + " " + order.currency;
}

function row(order) {
  const tr = document.createElement("tr");
  tr.dataset.orderId = order.id;
  for (const value of [order.id, order.customer, order.placedAt.slice(0, 10), order.status, money(order)]) {
    const td = document.createElement("td");
    td.textContent = value;
    tr.append(td);
  }
  return tr;
}

function show(which) {
  $("signin").hidden = which !== "signin";
  $("orders").hidden = which !== "orders";
}

async function load() {
  if (!token) {
    show("signin");
    return;
  }
  const me = await api("/api/session");
  if (me.status !== 200) {
    token = "";
    sessionStorage.clear();
    show("signin");
    return;
  }
  $("who").textContent = "Signed in as " + me.body.name + " (" + me.body.role + ")";
  const res = await api("/api/orders");
  if (res.status !== 200) {
    $("rows").replaceChildren();
    $("empty").hidden = false;
    $("empty").textContent = res.body.error || "Could not load orders.";
    show("orders");
    return;
  }
  $("rows").replaceChildren(...res.body.orders.map(row));
  $("empty").hidden = res.body.orders.length > 0;
  $("empty").textContent = "No orders yet.";
  show("orders");
}

$("signin-btn").addEventListener("click", async () => {
  const res = await api("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: $("name").value }),
  });
  if (res.status !== 200) {
    $("signin-error").textContent = res.body.error || "Could not sign in.";
    $("signin-error").hidden = false;
    return;
  }
  $("signin-error").hidden = true;
  token = res.body.token;
  sessionStorage.setItem("token", token);
  await load();
});

load();
