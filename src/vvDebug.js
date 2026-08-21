/**
 * TEMPORARY diagnostic — not part of the app. Delete this file (and its
 * import in main.jsx) once the iOS keyboard layout is settled.
 *
 * Enable by loading the app with ?vvdebug on the URL. Renders a live readout
 * of every measurement that could explain the header disappearing and the
 * gap above the keyboard.
 *
 * Small and bottom-right, deliberately: the first version was a full-width
 * opaque box pinned at the top, which likely covered the real header from
 * view in screenshots taken with it — and being a large fixed-position
 * element, may have been influencing Safari's own scroll-into-view
 * calculation for the focused input, rather than just observing it.
 *
 * "header visible" is computed directly (does its rect intersect the
 * current visual-viewport window?) rather than left for a screenshot to
 * show — that's the one number that answers the actual question
 * unambiguously, independent of anything this overlay might be obscuring.
 */
if (new URLSearchParams(location.search).has("vvdebug")) {
  const box = document.createElement("pre");
  box.style.cssText = [
    "position:fixed",
    "right:4px",
    "bottom:4px",
    "max-width:96vw",
    "z-index:2147483647",
    "margin:0",
    "padding:5px 7px",
    "font:600 10px/1.3 ui-monospace,Menlo,monospace",
    "color:#0f0",
    "background:rgba(0,0,0,.88)",
    "border-radius:4px",
    "white-space:pre",
  ].join(";");
  document.body.appendChild(box);

  const round = (n) => (typeof n === "number" ? Math.round(n) : n);

  const render = () => {
    const vv = window.visualViewport;
    const vvTop = vv ? vv.offsetTop : 0;
    const vvBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;

    const root = document.getElementById("root");
    const rootRect = root ? root.getBoundingClientRect() : null;
    const header = document.querySelector("header");
    const headerRect = header ? header.getBoundingClientRect() : null;
    const headerCS = header ? getComputedStyle(header) : null;
    const ta = document.querySelector('textarea[placeholder^="Message"]');
    const composer = ta ? ta.closest('[class*="bottom-0"]') : null;
    const composerRect = composer ? composer.getBoundingClientRect() : null;

    const intersects = (r) => !!r && r.bottom > vvTop && r.top < vvBottom;

    box.textContent = [
      `innerH ${round(window.innerHeight)}  vv.h ${round(vv && vv.height)}`,
      `PAN vv.offsetTop ${round(vvTop)}   scrollY ${round(window.scrollY)}`,
      `scrollTop ${round(document.scrollingElement?.scrollTop)}  --app-h ${getComputedStyle(document.documentElement).getPropertyValue("--app-height").trim() || "unset"}`,
      `root  top ${round(rootRect?.top)} h ${round(rootRect?.height)}`,
      `HEADER VISIBLE: ${intersects(headerRect)}   top ${round(headerRect?.top)} h ${round(headerRect?.height)} display ${headerCS?.display}`,
      `compo top ${round(composerRect?.top)} bot ${round(composerRect?.bottom)}  visible ${intersects(composerRect)}`,
      `focused ${document.activeElement?.tagName || "-"}`,
    ].join("\n");

    requestAnimationFrame(render);
  };
  requestAnimationFrame(render);
}
