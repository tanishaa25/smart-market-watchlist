import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { upgradeAccount, fetchSensitivity, updateSensitivity } from "../api.js";

const SENSITIVITY_OPTIONS = [
  { value: "calm", label: "Calm" },
  { value: "balanced", label: "Balanced" },
  { value: "active", label: "Active" },
];

export default function NavBar({ email, onLogout, onAuthed }) {
  const [upgrading, setUpgrading] = useState(false);
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sensitivity, setSensitivity] = useState("balanced");

  useEffect(() => {
    fetchSensitivity()
      .then((data) => setSensitivity(data.sensitivity))
      .catch(() => {}); // non-critical — just stays at the default display
  }, []);

  async function handleSensitivityChange(value) {
    setSensitivity(value); // optimistic
    try {
      await updateSensitivity(value);
    } catch {
      // Non-critical — worst case the setting doesn't persist this once; the UI already reflects the choice.
    }
  }

  async function handleUpgrade(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const { user } = await upgradeAccount(form.email, form.password);
      onAuthed?.(user);
      setUpgrading(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <nav className="navbar">
      <span className="brand">Smart Market Watchlist</span>
      <div className="nav-links">
        <NavLink to="/" end className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
          Dashboard
        </NavLink>
        <NavLink to="/browse" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
          Browse Stocks
        </NavLink>

        <div className="sensitivity-picker" title="How much has to happen before the briefing interrupts you">
          {SENSITIVITY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`sensitivity-btn ${sensitivity === opt.value ? "active" : ""}`}
              onClick={() => handleSensitivityChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Anonymous-first: no email yet means this is an anonymous
            session — offer saving it as an upgrade, never as a gate. */}
        {!email && !upgrading && (
          <button type="button" className="upgrade-prompt-btn" onClick={() => setUpgrading(true)}>
            Save my list — Sign up
          </button>
        )}
        {!email && upgrading && (
          <form className="upgrade-form" onSubmit={handleUpgrade}>
            <input
              type="email"
              placeholder="Email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              required
            />
            <input
              type="password"
              placeholder="Password (8+ chars)"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              required
            />
            <button type="submit" disabled={submitting}>
              {submitting ? "..." : "Save"}
            </button>
            <button type="button" className="upgrade-cancel-btn" onClick={() => setUpgrading(false)}>
              ✕
            </button>
          </form>
        )}
        {error && <span className="upgrade-error">{error}</span>}

        {email && <span className="nav-user">{email}</span>}
        {onLogout && (
          <button type="button" className="logout-btn" onClick={onLogout}>
            Log out
          </button>
        )}
      </div>
    </nav>
  );
}
