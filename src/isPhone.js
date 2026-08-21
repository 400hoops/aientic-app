/**
 * "Is this a phone" — the single query everything else here defers to:
 * the sidebar auto-collapsing, Enter-to-send vs. Enter-for-newline, and the
 * mobile font-size/input-zoom rules in index.css.
 *
 * Narrow viewport width alone isn't enough: a desktop browser window
 * resized or snapped narrow matches the same max-width breakpoint a phone
 * does. pointer: coarse alone isn't enough either — plenty of Windows
 * laptops have a touchscreen digitizer *in addition to* a mouse/trackpad,
 * and report pointer: coarse for that reason even while being driven
 * entirely by keyboard and mouse.
 *
 * hover: none is what actually distinguishes them: a laptop with a mouse or
 * trackpad reports hover: hover regardless of any touchscreen it also has,
 * since the OS knows a hover-capable device exists. Only a device with no
 * fine pointer available *at all* — an actual phone — reports hover: none.
 * All three conditions together is the standard way to detect a touch-
 * primary device rather than merely a touch-capable one.
 */
export const isPhone = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(max-width: 767px) and (hover: none) and (pointer: coarse)")
    .matches;
