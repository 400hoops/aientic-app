import { useEffect, useRef, useState } from "react";

import * as api from "./api.js";
import {
  IconPlus,
  IconSparkles,
  IconTrash,
  IconUpload,
  IconX,
} from "./Icons.jsx";
import ModelPicker from "./ModelPicker.jsx";

/**
 * Everything about *your* account, in one modal behind the name in the
 * sidebar: credentials, the model new chats start on, and getting history
 * in and out.
 *
 * Deliberately not the Admin page: that one is about other people's
 * accounts and the server's models, and needs the admin role. This works
 * the same for everyone.
 */
export default function SettingsDialog({
  user,
  models,
  modelId,
  theme,
  onModelChange,
  onToggleTheme,
  onImport,
  onUserChanged,
  onClose,
}) {
  const [username, setUsername] = useState(user.username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [accountNote, setAccountNote] = useState(null); // { error, text }
  const [importNote, setImportNote] = useState(null);
  const fileInput = useRef(null);

  // Memory: a plain list of lines added to the system turn of every chat.
  const [memories, setMemories] = useState(null); // null while loading
  const [draft, setDraft] = useState("");
  const [memoryNote, setMemoryNote] = useState(null);

  useEffect(() => {
    api
      .listMemories()
      .then((res) => setMemories(res.memories))
      .catch((err) => {
        setMemories([]);
        setMemoryNote({ error: true, text: err.message });
      });
  }, []);

  const runMemory = async (call) => {
    setMemoryNote(null);
    try {
      const { memories: next } = await call();
      setMemories(next);
    } catch (err) {
      setMemoryNote({ error: true, text: err.message });
    }
  };

  const addMemory = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await runMemory(() => api.addMemory(text));
  };

  /* ---------- skills ---------------------------------------------------- */

  const [skills, setSkills] = useState(null);
  const [skillDraft, setSkillDraft] = useState(null); // null = the form is closed
  const [skillNote, setSkillNote] = useState(null);

  useEffect(() => {
    api
      .listSkills()
      .then((res) => setSkills(res.skills))
      .catch((err) => {
        setSkills([]);
        setSkillNote({ error: true, text: err.message });
      });
  }, []);

  const runSkill = async (call) => {
    setSkillNote(null);
    try {
      const { skills: next } = await call();
      setSkills(next);
      return true;
    } catch (err) {
      setSkillNote({ error: true, text: err.message });
      return false;
    }
  };

  const saveSkill = async () => {
    const draft = skillDraft;
    const ok = await runSkill(() =>
      draft.id
        ? api.editSkill(draft.id, draft)
        : api.addSkill(draft)
    );
    if (ok) setSkillDraft(null);
  };

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dirty = username.trim() !== user.username || newPassword.length > 0;

  const saveAccount = async () => {
    setAccountNote(null);
    setSaving(true);
    try {
      const { user: next } = await api.updateAccount({
        username: username.trim(),
        currentPassword,
        newPassword: newPassword || undefined,
      });
      onUserChanged(next);
      setCurrentPassword("");
      setNewPassword("");
      setAccountNote({ text: "Saved." });
    } catch (err) {
      setAccountNote({ error: true, text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const chooseFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImportNote({ text: `Importing ${file.name}…` });
    try {
      const result = await onImport(file);
      setImportNote({
        text: `Imported ${result.imported} chat${result.imported === 1 ? "" : "s"}, ${result.messages} messages.`,
      });
    } catch (err) {
      setImportNote({ error: true, text: err.message });
    }
  };

  const field =
    `w-full rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-2
     text-[length:var(--fs-sm2)] text-[var(--text)] placeholder:text-[var(--faint)]
     focus:border-[var(--focus)] focus:outline-none`;

  const note = (value) =>
    value && (
      <p
        className={`text-[length:var(--fs-xs)] ${
          value.error ? "text-[var(--danger)]" : "text-[var(--muted)]"
        }`}
      >
        {value.text}
      </p>
    );

  const Section = ({ title, description, children }) => (
    <section className="border-t border-[var(--border)] px-5 py-4 first:border-t-0">
      <h3 className="text-[length:var(--fs-sm2)] font-medium">{title}</h3>
      {description && (
        <p className="mt-0.5 text-[length:var(--fs-xs)] text-[var(--muted)]">
          {description}
        </p>
      )}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );

  return (
    <div
      // Click the backdrop to dismiss; clicks inside the card stop there.
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 animate-fade-in"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="max-h-full w-full max-w-lg overflow-y-auto rounded-2xl border border-[var(--border)]
                   bg-[var(--panel)] shadow-[0_20px_60px_rgba(0,0,0,0.25)] animate-scale-in"
      >
        <header className="flex items-center justify-between px-5 py-4">
          <h2 className="text-[length:var(--fs-md)]">Settings</h2>
          <button
            onClick={onClose}
            title="Close"
            className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--hover)]"
          >
            <IconX className="h-[17px] w-[17px]" />
          </button>
        </header>

        <Section
          title="Account"
          description="Changing either one needs your current password."
        >
          <label className="block space-y-1">
            <span className="text-[length:var(--fs-xs)] text-[var(--muted)]">Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className={field}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[length:var(--fs-xs)] text-[var(--muted)]">
              Current password
            </span>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              className={field}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[length:var(--fs-xs)] text-[var(--muted)]">
              New password <span className="text-[var(--faint)]">— leave blank to keep it</span>
            </span>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              className={field}
            />
          </label>
          <div className="flex items-center justify-between gap-3">
            {note(accountNote) || <span />}
            <button
              onClick={saveAccount}
              disabled={saving || !dirty || !currentPassword}
              className="shrink-0 rounded-lg bg-[var(--text)] px-3 py-1.5 text-[length:var(--fs-sm)]
                         text-[var(--bg)] disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </Section>

        <Section
          title="Default model"
          description="What a new chat starts on, remembered on this device."
        >
          <div className="relative flex items-center rounded-lg border border-[var(--border)]
                          bg-[var(--raised)] px-2.5 py-1.5">
            <ModelPicker
              models={models}
              value={modelId}
              onChange={onModelChange}
              placement="bottom"
            />
          </div>
        </Section>

        <Section
          title="Memory"
          description="Told to the model at the start of every chat, in every conversation. Nothing is added here on its own — this list is exactly what it's told."
        >
          {memories === null ? (
            <p className="text-[length:var(--fs-xs)] text-[var(--muted)]">Loading…</p>
          ) : memories.length === 0 ? (
            <p className="text-[length:var(--fs-xs)] text-[var(--faint)]">
              Nothing remembered yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {memories.map((m) => (
                <li
                  key={m.id}
                  className="group flex items-start gap-2 rounded-lg border border-[var(--border)]
                             bg-[var(--raised)] px-3 py-2"
                >
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words
                                   text-[length:var(--fs-sm2)]">
                    {m.text}
                  </span>
                  <button
                    onClick={() => runMemory(() => api.removeMemory(m.id))}
                    title="Forget this"
                    className="shrink-0 rounded p-1 text-[var(--faint)] transition
                               hover:text-[var(--danger)] md:opacity-0 md:group-hover:opacity-100"
                  >
                    <IconTrash className="h-[14px] w-[14px]" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addMemory();
                }
              }}
              placeholder="My dog's name is Beans"
              className={field}
            />
            <button
              onClick={addMemory}
              disabled={!draft.trim()}
              title="Remember this"
              className="shrink-0 rounded-lg border border-[var(--border)] p-2
                         hover:bg-[var(--hover)] disabled:opacity-40"
            >
              <IconPlus className="h-[16px] w-[16px]" />
            </button>
          </div>
          {note(memoryNote)}
        </Section>

        <Section
          title="Skills"
          description="Named instructions you can hand a chat — a voice to write in, a role to answer as. Attach one from the sparkle in the composer; it stays with that chat. Always-on skills apply to every chat without asking."
        >
          {skills === null ? (
            <p className="text-[length:var(--fs-xs)] text-[var(--muted)]">Loading…</p>
          ) : skills.length === 0 ? (
            <p className="text-[length:var(--fs-xs)] text-[var(--faint)]">
              No skills yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {skills.map((skill) => (
                <li
                  key={skill.id}
                  className="group flex items-start gap-2 rounded-lg border border-[var(--border)]
                             bg-[var(--raised)] px-3 py-2"
                >
                  <IconSparkles className="mt-0.5 h-[15px] w-[15px] shrink-0 text-[var(--muted)]" />
                  <button
                    onClick={() => setSkillDraft({ ...skill })}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-[length:var(--fs-sm2)]">
                      {skill.name}
                    </span>
                    <span className="block truncate text-[length:var(--fs-xs)] text-[var(--muted)]">
                      {skill.description || skill.instructions}
                    </span>
                  </button>
                  <label
                    title="Apply to every chat"
                    className="flex shrink-0 items-center gap-1.5 text-[length:var(--fs-xs)] text-[var(--muted)]"
                  >
                    <input
                      type="checkbox"
                      checked={!!skill.always}
                      onChange={(e) =>
                        runSkill(() =>
                          api.editSkill(skill.id, { always: e.target.checked })
                        )
                      }
                    />
                    Always
                  </label>
                  <button
                    onClick={() => runSkill(() => api.removeSkill(skill.id))}
                    title="Delete this skill"
                    className="shrink-0 rounded p-1 text-[var(--faint)] transition
                               hover:text-[var(--danger)] md:opacity-0 md:group-hover:opacity-100"
                  >
                    <IconTrash className="h-[14px] w-[14px]" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {skillDraft ? (
            <div className="space-y-2 rounded-lg border border-[var(--border)] p-3">
              <input
                value={skillDraft.name}
                onChange={(e) =>
                  setSkillDraft({ ...skillDraft, name: e.target.value })
                }
                placeholder="Name — “Email voice”"
                className={field}
              />
              <input
                value={skillDraft.description || ""}
                onChange={(e) =>
                  setSkillDraft({ ...skillDraft, description: e.target.value })
                }
                placeholder="One line about when to use it (optional)"
                className={field}
              />
              <textarea
                value={skillDraft.instructions}
                onChange={(e) =>
                  setSkillDraft({ ...skillDraft, instructions: e.target.value })
                }
                rows={5}
                placeholder="Instructions — what the model should do when this skill is on."
                className={`${field} resize-y`}
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setSkillDraft(null)}
                  className="rounded-lg px-3 py-1.5 text-[length:var(--fs-sm)] text-[var(--muted)]
                             hover:bg-[var(--hover)]"
                >
                  Cancel
                </button>
                <button
                  onClick={saveSkill}
                  disabled={!skillDraft.name.trim() || !skillDraft.instructions.trim()}
                  className="rounded-lg bg-[var(--text)] px-3 py-1.5 text-[length:var(--fs-sm)]
                             text-[var(--bg)] disabled:opacity-40"
                >
                  {skillDraft.id ? "Save skill" : "Add skill"}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() =>
                setSkillDraft({ name: "", description: "", instructions: "" })
              }
              className="flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-1.5
                         text-[length:var(--fs-sm)] hover:bg-[var(--hover)]"
            >
              <IconPlus className="h-[16px] w-[16px]" />
              New skill
            </button>
          )}
          {note(skillNote)}
        </Section>

        <Section title="Appearance">
          <button
            onClick={onToggleTheme}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5
                       text-[length:var(--fs-sm)] hover:bg-[var(--hover)]"
          >
            Switch to {theme === "dark" ? "light" : "dark"} mode
          </button>
        </Section>

        <Section
          title="Your chats"
          description="Import a Claude data export — the zip from Settings → Privacy → Export data, or the conversations.json inside it. Each chat is also kept on the server as its own .json and .md file."
        >
          <button
            onClick={() => fileInput.current?.click()}
            className="flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-1.5
                       text-[length:var(--fs-sm)] hover:bg-[var(--hover)]"
          >
            <IconUpload className="h-[16px] w-[16px]" />
            Import chats
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,.json,application/zip,application/json"
            onChange={chooseFile}
            className="hidden"
          />
          {note(importNote)}
        </Section>
      </div>
    </div>
  );
}
