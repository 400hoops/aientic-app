import { useEffect, useState } from "react";
import * as api from "../api.js";
import AdminShell from "./AdminShell.jsx";
import Select from "../Select.jsx";

/* ---------- shared bits -------------------------------------------------- */

const card =
  "rounded-xl border border-[var(--border)] bg-[var(--panel)] px-6 py-5";
const field =
  "w-full rounded-lg border border-[var(--border-strong)] bg-[var(--raised)] px-3.5 py-2.5 " +
  "text-[14px] max-md:text-[16px] text-[var(--text)] placeholder:text-[var(--faint)] " +
  "focus:border-[var(--focus)] focus:outline-none";
const label = "mb-1.5 block text-[13px] text-[var(--text-soft)]";
const primary =
  "rounded-lg bg-[var(--text)] px-4 py-2.5 text-[13.5px] text-[var(--bg)] " +
  "transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
const secondary =
  "rounded-lg border border-[var(--border-strong)] bg-[var(--raised)] px-4 py-2.5 " +
  "text-[13.5px] text-[var(--text)] hover:border-[var(--muted)] disabled:opacity-50";

function Banner({ error, notice }) {
  if (!error && !notice) return null;
  return (
    <div
      className={`mb-6 animate-fade-up rounded-lg border px-4 py-3 text-[13.5px] ${
        error
          ? "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]"
          : "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)]"
      }`}
    >
      {error || notice}
    </div>
  );
}

/* ---------- endpoints ---------------------------------------------------- */

function Endpoints({ onChanged }) {
  const [endpoints, setEndpoints] = useState([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [manual, setManual] = useState({ label: "", note: "", modelParam: "" });
  const [showManual, setShowManual] = useState(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = () =>
    api
      .listEndpoints()
      .then((res) => setEndpoints(res.endpoints))
      .catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const guard = async (fn) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const importAll = () =>
    guard(async () => {
      const res = await api.importModels(baseUrl, apiKey);
      setEndpoints(res.endpoints);
      onChanged?.();
      setPreview(null);
      setNotice(
        res.added.length
          ? `Added ${res.added.length} model${res.added.length === 1 ? "" : "s"}` +
              (res.skipped ? `, skipped ${res.skipped} already listed.` : ".")
          : "Nothing new — every model on that server is already listed.",
      );
    });

  const previewModels = () =>
    guard(async () => {
      const res = await api.previewModels(baseUrl, apiKey);
      setPreview(res.models);
      if (!res.models.length) setNotice("That server reports no models.");
    });

  const addManual = () =>
    guard(async () => {
      await api.addEndpoint({ ...manual, baseUrl, apiKey });
      setManual({ label: "", note: "", modelParam: "" });
      await load();
      onChanged?.();
      setNotice("Endpoint added.");
    });

  const remove = (endpoint) =>
    guard(async () => {
      if (!window.confirm(`Delete the "${endpoint.label}" endpoint?`)) return;
      const res = await api.removeEndpoint(endpoint.id);
      setEndpoints(res.endpoints);
      onChanged?.();
    });

  return (
    <>
      <h2 className="mb-5 text-[17px] font-semibold">Model endpoints</h2>
      <Banner error={error} notice={notice} />

      <div className={card}>
        <div
          className="grid gap-5
                     [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]"
        >
          <div>
            <span className={label}>Server base URL</span>
            <input
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                // A stale list under a changed URL is worse than no list.
                setPreview(null);
              }}
              placeholder="http://192.168.1.10:8081"
              className={field}
            />
          </div>
          <div>
            <span className={label}>Upstream API key (optional)</span>
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              autoComplete="off"
              placeholder="Only if the server requires one"
              className={field}
            />
          </div>
        </div>

        <div className="mt-4 flex gap-3">
          <button
            onClick={importAll}
            disabled={busy || !baseUrl.trim()}
            className={primary}
          >
            {busy ? "Working…" : "Add all models from this server"}
          </button>
          <button
            onClick={previewModels}
            disabled={busy || !baseUrl.trim()}
            className={secondary}
          >
            Preview models
          </button>
        </div>

        <p className="mt-4 text-[13px] leading-relaxed text-[var(--faint)]">
          Base URL is the root of your llama-server (or any OpenAI-compatible
          server) —{" "}
          <code className="rounded bg-[var(--panel-2)] px-1.5 py-0.5 font-mono text-[12px]">
            /v1/chat/completions
          </code>{" "}
          is appended automatically. Adding all models names each one after its
          server-side preset; re-run it any time to pick up new models without
          duplicating existing ones. The upstream key is stored server-side,
          shared across models on the same server, and never sent back to the
          browser.
        </p>

        {preview && (
          <div className="mt-4 animate-fade-up rounded-lg border border-[var(--border)] bg-[var(--raised)] px-4 py-3">
            <div className="mb-2 text-[12.5px] text-[var(--faint)]">
              {preview.length} model{preview.length === 1 ? "" : "s"} on that
              server
            </div>
            <div className="flex flex-wrap gap-1.5">
              {preview.map((m) => (
                <span
                  key={m.id}
                  className="rounded-md bg-[var(--panel-2)] px-2 py-1 font-mono text-[12px]"
                >
                  {m.id}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <button
            onClick={() => setShowManual((v) => !v)}
            className="text-[13.5px] text-[var(--muted)] hover:text-[var(--text)]"
          >
            {showManual ? "▾" : "▸"} Add a single model manually
          </button>

          {showManual && (
            <div className="mt-4">
              <div
                className="grid gap-5
                           [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]"
              >
                <div>
                  <span className={label}>Label</span>
                  <input
                    value={manual.label}
                    onChange={(e) =>
                      setManual({ ...manual, label: e.target.value })
                    }
                    placeholder="Llama 3 70B"
                    className={field}
                  />
                </div>
                <div>
                  <span className={label}>Note</span>
                  <input
                    value={manual.note}
                    onChange={(e) =>
                      setManual({ ...manual, note: e.target.value })
                    }
                    placeholder="70B, Q4_K_M"
                    className={field}
                  />
                </div>
                <div>
                  <span className={label}>Model param</span>
                  <input
                    value={manual.modelParam}
                    onChange={(e) =>
                      setManual({ ...manual, modelParam: e.target.value })
                    }
                    placeholder="llama-3-70b-instruct"
                    className={field}
                  />
                </div>
              </div>
              <button
                onClick={addManual}
                disabled={
                  busy ||
                  !baseUrl.trim() ||
                  !manual.label.trim() ||
                  !manual.modelParam.trim()
                }
                className={`${secondary} mt-4`}
              >
                Add endpoint
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="bg-[var(--panel)] text-[11.5px] uppercase tracking-wide text-[var(--faint)]">
              <th className="px-4 py-3 text-left font-medium">Label</th>
              <th className="px-4 py-3 text-left font-medium">Base URL</th>
              <th className="px-4 py-3 text-left font-medium">Model param</th>
              <th className="px-4 py-3 text-left font-medium">Key</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {endpoints.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-6 text-center text-[var(--faint)]"
                >
                  No endpoints yet.
                </td>
              </tr>
            )}
            {endpoints.map((e) => (
              <tr key={e.id} className="border-t border-[var(--border)]">
                <td className="px-4 py-3">
                  {e.label}
                  {e.note && (
                    <span className="ml-2 text-[12px] text-[var(--faint)]">
                      {e.note}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-[12.5px] text-[var(--text-soft)]">
                  {e.baseUrl}
                </td>
                <td className="px-4 py-3 font-mono text-[12.5px] text-[var(--text-soft)]">
                  {e.modelParam}
                </td>
                <td className="px-4 py-3 text-[var(--faint)]">
                  {e.hasKey ? "set" : "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => remove(e)}
                    className="text-[var(--danger)] hover:underline"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------- accounts ----------------------------------------------------- */

function Users({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [draft, setDraft] = useState({
    username: "",
    password: "",
    role: "user",
  });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .listUsers()
      .then((res) => setUsers(res.users))
      .catch((err) => setError(err.message));
  }, []);

  const add = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.addUser(draft.username, draft.password, draft.role);
      setUsers(res.users);
      setDraft({ username: "", password: "", role: "user" });
      setNotice(`Added ${res.user.username}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (user) => {
    if (
      !window.confirm(
        `Delete ${user.username}? Their conversations are deleted with the account.`,
      )
    )
      return;
    setError(null);
    try {
      const res = await api.removeUser(user.id);
      setUsers(res.users);
    } catch (err) {
      setError(err.message);
    }
  };

  const changeRole = async (user, role) => {
    if (role === user.role) return;
    setError(null);
    setNotice(null);
    try {
      const res = await api.updateUser(user.id, { role });
      setUsers(res.users);
    } catch (err) {
      setError(err.message);
    }
  };

  // Which row's password field is open, and its draft value — an inline
  // reveal rather than a modal, matching how editing a chat message works
  // elsewhere in the app.
  const [changingId, setChangingId] = useState(null);
  const [newPassword, setNewPassword] = useState("");
  const [changing, setChanging] = useState(false);

  const startChangingPassword = (user) => {
    setChangingId(user.id);
    setNewPassword("");
    setError(null);
    setNotice(null);
  };

  const submitPassword = async (user) => {
    if (newPassword.length < 8) return;
    setChanging(true);
    setError(null);
    try {
      await api.setUserPassword(user.id, newPassword);
      setChangingId(null);
      setNewPassword("");
      setNotice(`Password changed for ${user.username}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setChanging(false);
    }
  };

  return (
    <>
      <h2 className="mb-5 text-[17px] font-semibold">Accounts</h2>
      <Banner error={error} notice={notice} />

      <div className={card}>
        <div
          className="grid gap-5
                           [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]"
        >
          <div>
            <span className={label}>Username</span>
            <input
              value={draft.username}
              onChange={(e) => setDraft({ ...draft, username: e.target.value })}
              autoComplete="off"
              className={field}
            />
          </div>
          <div>
            <span className={label}>Password</span>
            <input
              type="password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              autoComplete="new-password"
              className={field}
            />
          </div>
          <div>
            <span className={label}>Role</span>
            <Select
              value={draft.role}
              onChange={(role) => setDraft({ ...draft, role })}
              width={220}
              options={[
                { value: "user", label: "User" },
                { value: "admin", label: "Admin" },
              ]}
            />
          </div>
        </div>

        <p className="mt-4 text-[13px] text-[var(--faint)]">
          Passwords must be at least 8 characters. Admins can manage endpoints,
          sampler settings and accounts.
        </p>

        <button
          onClick={add}
          disabled={busy || !draft.username.trim() || draft.password.length < 8}
          className={`${primary} mt-4`}
        >
          Add account
        </button>
      </div>

      <div className="mt-6 overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="bg-[var(--panel)] text-[11.5px] uppercase tracking-wide text-[var(--faint)]">
              <th className="px-4 py-3 text-left font-medium">Username</th>
              <th className="px-4 py-3 text-left font-medium">Role</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-[var(--border)]">
                <td className="px-4 py-3">
                  {u.username}
                  {u.id === currentUser.id && (
                    <span className="ml-2 text-[12px] text-[var(--faint)]">
                      (You)
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="w-[128px]">
                    <Select
                      value={u.role}
                      onChange={(role) => changeRole(u, role)}
                      width={128}
                      options={[
                        { value: "user", label: "User" },
                        { value: "admin", label: "Admin" },
                      ]}
                    />
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  {changingId === u.id ? (
                    <div className="flex items-center justify-end gap-2">
                      <input
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        onKeyDown={(e) =>
                          e.key === "Enter" && submitPassword(u)
                        }
                        autoFocus
                        autoComplete="new-password"
                        placeholder="New password"
                        className={`${field} w-40 py-1.5 text-left`}
                      />
                      <button
                        onClick={() => submitPassword(u)}
                        disabled={changing || newPassword.length < 8}
                        className="text-[var(--text)] hover:underline disabled:cursor-not-allowed
                                   disabled:text-[var(--faint)] disabled:no-underline"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setChangingId(null)}
                        className="text-[var(--muted)] hover:underline"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-end gap-4">
                      <button
                        onClick={() => startChangingPassword(u)}
                        className="text-[var(--muted)] hover:text-[var(--text)] hover:underline"
                      >
                        Change password
                      </button>
                      <button
                        onClick={() => remove(u)}
                        disabled={u.id === currentUser.id}
                        className="text-[var(--danger)] hover:underline disabled:cursor-not-allowed
                                   disabled:text-[var(--faint)] disabled:no-underline"
                        title={
                          u.id === currentUser.id
                            ? "You can't delete the account you're signed in to"
                            : "Delete account"
                        }
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------- page --------------------------------------------------------- */

export default function AdminPage({
  user,
  onBack,
  sidebarOpen,
  onShowSidebar,
  onEndpointsChanged,
}) {
  const [tab, setTab] = useState("endpoints");

  return (
    <AdminShell
      tab={tab}
      onTab={setTab}
      onBack={onBack}
      sidebarOpen={sidebarOpen}
      onShowSidebar={onShowSidebar}
    >
      {/* Keyed on the tab so switching tabs re-runs the entry animation
          (the panels already remount on tab change — this just makes it
          visible as a settle rather than a hard cut). */}
      <div key={tab} className="animate-fade-up">
        {tab === "endpoints" ? (
          <Endpoints onChanged={onEndpointsChanged} />
        ) : (
          <Users currentUser={user} />
        )}
      </div>
    </AdminShell>
  );
}
