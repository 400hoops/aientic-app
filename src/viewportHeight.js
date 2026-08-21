/**
 * Sizes #root to the height that's actually visible, via --app-height.
 *
 * Diagnosed from real on-device measurements (iOS 27 Safari, keyboard open):
 *
 *     innerH 334   vv.height 334   vv.offsetTop 288
 *     scrollTop 288
 *     root top -288  h 622
 *     header top -288  h 56  display flex   ← not hidden, just scrolled away
 *
 * #root's `height: 100%` resolves against a layout viewport that does *not*
 * shrink when the keyboard opens, so root stayed 622px tall inside a 334px
 * window. That 288px of overflow made the document scrollable, Safari
 * scrolled it to bring the focused composer into view, and the header —
 * perfectly healthy at document y=0 — ended up 288px above the visible area.
 *
 * Sizing root to visualViewport.height removes the overflow entirely: with
 * nothing to scroll, there is nothing to scroll the header out of.
 *
 * Deliberately does NOT reposition anything. Earlier attempts this session
 * used position: fixed (which anchors to the layout viewport and slid the
 * app off-screen) and offset the app by visualViewport.offsetTop to cancel
 * Safari's pan (which oscillated: cancelling the pan removes the reason for
 * it, Safari undoes it, the app snaps back, repeat). Removing the *cause* of
 * the scroll works where fighting its *effects* did not.
 */
function sync() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
}

// The keyboard's slide runs ~250-300ms and resize doesn't fire steadily
// across it, so one reading can land mid-animation on a height that's about
// to change again. Re-read each frame for a short window after any change.
let settleUntil = 0;
function settle(now) {
  // Height tracking runs every frame: it follows the keyboard's slide
  // smoothly and never fights it, since it only reports what the viewport
  // already is.
  sync();

  if (now < settleUntil) {
    requestAnimationFrame(settle);
    return;
  }

  // The pan correction runs once, here at the end — not per frame.
  //
  // Safari re-pans continuously while the keyboard slides, so resetting the
  // scroll on every frame meant Safari panned and this yanked it back ~60
  // times over the animation: a visible bounce before the layout settled.
  // Waiting until the viewport has stopped moving corrects the leftover pan
  // in one step, invisibly.
  //
  // Still not the offset-compensation that oscillated earlier: that ran
  // forever, chasing a pan it kept re-triggering. This is a single
  // correction after motion ends, to the only valid scroll value (there is
  // no overflow to scroll once root matches the window).
  // Checked against visualViewport.offsetTop, not window.scrollY: the
  // document has overflow: hidden, so scrollY is pinned at 0 and a scrollY
  // guard silently never fired. The pan lives in offsetTop, which scrollY
  // does not reflect.
  const panned = (window.visualViewport?.offsetTop ?? 0) !== 0;
  if (panned || window.scrollY !== 0) window.scrollTo(0, 0);
}
function onViewportChange() {
  const alreadySettling = settleUntil > performance.now();
  settleUntil = performance.now() + 400;
  if (!alreadySettling) requestAnimationFrame(settle);
}

sync();

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", onViewportChange);
  // Pans fire scroll without resize, and that is exactly the case being
  // corrected above — resize alone would miss it.
  window.visualViewport.addEventListener("scroll", onViewportChange);
} else {
  window.addEventListener("resize", onViewportChange);
}
window.addEventListener("orientationchange", onViewportChange);
