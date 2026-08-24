import { useEffect, useRef, useState } from "react";
import * as api from "./api.js";
import ModelPicker from "./ModelPicker.jsx";
import { IconPanel } from "./Icons.jsx";

/**
 * Sampler settings, per model, owned by the admin.
 *
 * These are not per-user preferences: the server applies them to every
 * request for that model, so what one person tests is what everyone gets.
 */

const SLIDERS = [
  ["temperature", 0, 2, 0.01],
  ["top_p", 0, 1, 0.01],
  ["top_k", 0, 100, 1],
  ["min_p", 0, 1, 0.01],
  ["repeat_penalty", 1, 2, 0.01],
];

const round = (n) => Math.round(n * 100) / 100;

/** Where the numbers on screen came from, said plainly. */
const DEFAULTS_NOTE = {
  server: "Defaults are the ones this model reports for itself.",
  // Worth spelling out: the real values exist, they just can't be read
  // without loading the model, and loading it isn't something opening a
  // settings page should do.
  idle: "This model isn't loaded, so its own defaults can't be read yet — llama.cpp's are shown. Send it a message, then reopen this page.",
  unreachable: "Can't reach the model server, so llama.cpp's defaults are shown.",
  fallback: "This server doesn't report its own defaults, so llama.cpp's are shown.",
};

/** Key order varies between a loaded sampler and a reset one, so sort it. */
const fingerprint = (obj) =>
  JSON.stringify(
    Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)))
  );

export default function SamplerPage({
  models,
  modelStatus = {},
  modelId,
  onModelChange,
  onBack,
  sidebarOpen,
  onShowSidebar,
}) {
  const [sampler, setSampler] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [defaultsSource, setDefaultsSource] = useState(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState(null);

  // What the server currently holds, as loaded or last saved. Opening the
  // page is not an edit, so this is what tells a real change from the state
  // simply arriving — otherwise every visit wrote back what it had just read
  // and flashed "Saved" at a page nobody had touched.
  const savedRef = useRef(null); // { id, json }

  const selected = models.find((m) => m.id === modelId) || models[0] || null;

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;

    setSampler(null);
    setDefaults(null);
    setStatus("");

    api
      .getSampler(selected.id)
      .then((res) => {
        if (cancelled) return;
        savedRef.current = { id: selected.id, json: fingerprint(res.sampler) };
        setSampler(res.sampler);
        setDefaults(res.defaults);
        setDefaultsSource(res.defaultsSource || null);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  // Saves are debounced: dragging a slider shouldn't be one PUT per pixel.
  useEffect(() => {
    if (!sampler || !selected) return;

    // Nothing loaded for this model yet, or nothing actually changed.
    const saved = savedRef.current;
    if (!saved || saved.id !== selected.id) return;
    const json = fingerprint(sampler);
    if (json === saved.json) return;

    const timer = setTimeout(() => {
      setStatus("Saving…");
      api
        .saveSampler(selected.id, sampler)
        .then((res) => {
          savedRef.current = {
            id: selected.id,
            json: fingerprint(res.sampler ?? sampler),
          };
          setStatus("Saved");
        })
        .catch((err) => {
          setStatus("");
          setError(err.message);
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [sampler, selected?.id]);

  useEffect(() => {
    if (status !== "Saved") return;
    const timer = setTimeout(() => setStatus(""), 1600);
    return () => clearTimeout(timer);
  }, [status]);

  const set = (key, value) => setSampler((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="flex min-w-0 animate-fade-in flex-1 flex-col">
      <header style={{ transform: "translateZ(0)" }}
      className="sticky top-0 z-10 bg-[var(--bg)] flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border)] px-4">
        {!sidebarOpen && (
          <button
            onClick={onShowSidebar}
            title="Show sidebar"
            className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--hover)]"
          >
            <IconPanel className="h-[18px] w-[18px] shrink-0" />
          </button>
        )}
        <h1 className="text-[14.5px] text-[var(--text-soft)]">Sampler</h1>
        <ModelPicker
          models={models}
          value={selected?.id}
          onChange={onModelChange}
          placement="bottom"
          tone="header"
          status={modelStatus}
        />
        <button
          onClick={onBack}
          className="ml-auto text-[13.5px] text-[var(--muted)] hover:text-[var(--text)]"
        >
          Back to chat
        </button>
      </header>

      <div className="flex-1 overflow-y-scroll">
        <div className="mx-auto max-w-3xl px-6 py-10 max-md:px-4">
          {!selected && (
            <p className="text-[14px] text-[var(--faint)]">
              Add a model endpoint first — Admin → Endpoints.
            </p>
          )}

          {error && (
            <div className="mb-6 animate-fade-up rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)]
                            px-4 py-3 text-[14px] text-[var(--danger)]">
              {error}
            </div>
          )}

          {/* Keyed on the model: switching models remounts the block and the
              settings settle in again rather than swapping in place. */}
          {selected && sampler && (
            <div key={selected.id} className="animate-fade-up">
              {/* The save status shares this row, so its slot is always
                  present at a fixed width: an empty span would change the
                  row's baseline (shifting the page) and let "Reset to
                  defaults" slide as the wording changes. */}
              <div className="mb-1 flex h-7 items-center justify-between">
                <h2 className="text-[17px] font-semibold">{selected.label}</h2>
                <div className="flex items-center gap-4 text-[13px]">
                  <span
                    aria-live="polite"
                    className={`w-14 text-right text-[var(--faint)] transition-opacity
                                duration-200 motion-reduce:transition-none
                                ${status ? "opacity-100" : "opacity-0"}`}
                  >
                    {status || "Saved"}
                  </span>
                  <button
                    onClick={() => setSampler({ ...defaults })}
                    className="text-[var(--muted)] hover:text-[var(--text)]"
                  >
                    Reset to defaults
                  </button>
                </div>
              </div>

              <p className="mb-8 text-[13.5px] text-[var(--faint)]">
                These settings apply to every user of this model and are enforced by
                the server.{" "}
                {DEFAULTS_NOTE[defaultsSource] || ""}
              </p>

              <div
                className="grid gap-x-8 gap-y-6
                           [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]"
              >
                {SLIDERS.map(([key, min, max, step]) => (
                  <label key={key} className="block">
                    <div className="mb-2 flex justify-between text-[13px]">
                      <span className="text-[var(--muted)]">{key}</span>
                      <span className="tabular-nums text-[var(--text)]">
                        {round(sampler[key])}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      step={step}
                      value={sampler[key]}
                      style={{
                        "--fill": `${((sampler[key] - min) / (max - min)) * 100}%`,
                      }}
                      onChange={(e) => set(key, Number(e.target.value))}
                      className="w-full"
                    />
                  </label>
                ))}
              </div>

              <p className="mt-10 text-[13.5px] text-[var(--faint)]">
                Reply length is llama-server's to decide, from its own n-predict and
                context size. There is nothing to set here.
              </p>

              <label className="mt-8 block">
                <div className="mb-2 text-[13.5px] text-[var(--text-soft)]">
                  System prompt
                </div>
                <textarea
                  value={sampler.systemPrompt}
                  onChange={(e) => set("systemPrompt", e.target.value)}
                  rows={6}
                  placeholder="Applies to every user of this model. Leave empty for the model's built-in default."
                  className="w-full resize-y rounded-xl border border-[var(--border-strong)]
                             bg-transparent px-4 py-3 font-mono text-[13px] max-md:text-[16px] leading-relaxed
                             text-[var(--text)] placeholder:text-[var(--faint)]
                             focus:border-[var(--focus)] focus:outline-none"
                />
                <div className="mt-2 text-[12.5px] leading-relaxed text-[var(--faint)]">
                  {"{{CURRENT_WEEKDAY}}, {{CURRENT_DATETIME}} and {{CURRENT_TIMEZONE}} are filled with the user's real clock at send time; {{USER_NAME}} is replaced with the signed-in user's name. Anything else in {{DOUBLE_BRACES}} is left as-is."}
                </div>
              </label>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
