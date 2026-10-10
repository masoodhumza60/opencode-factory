import { useState } from "react";
import { OrdersPage } from "./orders/OrdersPage";
import { createMemoryStore } from "./orders/store";
import type { OrderStore } from "./orders/store";
import { can, readSession, writeSession } from "./auth/session";
import type { Role, Session } from "./auth/session";

const store: OrderStore = createMemoryStore();

function SignIn({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("staff");
  return (
    <div className="card">
      <h2>Sign in</h2>
      <div className="row">
        <label htmlFor="username">
          Username
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label htmlFor="role">
          Role
          <select id="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="viewer">viewer</option>
            <option value="staff">staff</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button
          className="primary"
          disabled={username.trim() === ""}
          onClick={() => onSignedIn({ username: username.trim(), role })}
        >
          Sign in
        </button>
      </div>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => readSession());
  const [tab, setTab] = useState<"orders">("orders");

  if (!session) {
    return (
      <div className="app">
        <h1>Orderboard</h1>
        <SignIn
          onSignedIn={(s) => {
            writeSession(s);
            setSession(s);
          }}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="nav">
        <button aria-current={tab === "orders" ? "page" : undefined} onClick={() => setTab("orders")}>
          Orders
        </button>
        <span style={{ flex: 1 }} />
        <span className="status">Signed in as {session.username}</span>
        <button
          className="link"
          onClick={() => {
            writeSession(null);
            setSession(null);
          }}
        >
          Sign out
        </button>
      </header>

      {tab === "orders" ? (
        <>
          <OrdersPage store={store} />
          <p className="status">
            {can(session, "export_orders")
              ? "You can export orders."
              : "Exporting orders requires the admin role."}
          </p>
        </>
      ) : null}
    </div>
  );
}
