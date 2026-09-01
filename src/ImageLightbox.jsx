import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconX } from "./Icons.jsx";

/**
 * Chat image viewer.
 *
 * An image rendered through PreviewableImage opens a full-screen lightbox;
 * Escape, the close button, or tapping the backdrop dismisses it. A
 * double-tap (double-click) zooms 2.5× centred on the tap point; while
 * zoomed, drag to pan, double-tap again to reset.
 *
 * The lightbox is portalled to document.body. Without the portal it renders
 * inside the message wrapper, whose animate-fade-up (fill-mode: both) leaves
 * a persistent transform: translateY(0) behind — and any transformed
 * ancestor becomes the containing block for position: fixed descendants, so
 * the "full-screen" backdrop collapsed to the size of that one message and
 * the image spilled out of it. Most visible on phones, where the enlarged
 * portrait photo dwarfs the box it was trapped in.
 */

const ZOOM = 2.5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function Lightbox({ src, onClose }) {
  const imgRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(null); // { startX, startY, pan, moved }
  const lastTapRef = useRef({ t: 0, x: 0, y: 0 });

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const reset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  /* Double-tap / double-click toggles the zoom: at rest it zooms in
     centred on the tap point so the tapped spot stays under the finger
     (the translate compensates for scaling about the image centre);
     while zoomed it resets. A released drag must not count as a tap. A
     single tap does nothing either way — reset only on a deliberate
     double-tap, otherwise the second tap of the pair would immediately
     re-zoom the view the first tap just reset. */
  const onImgPointerUp = (e) => {
    const wasDrag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (wasDrag?.moved) return;

    const now = performance.now();
    const last = lastTapRef.current;
    const isDouble =
      now - last.t < 300 &&
      Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30;
    lastTapRef.current = { t: now, x: e.clientX, y: e.clientY };
    if (!isDouble) return;

    if (zoom > 1) {
      reset();
      return;
    }
    const r = imgRef.current.getBoundingClientRect();
    setPan({
      x: (1 - ZOOM) * (e.clientX - (r.x + r.width / 2)),
      y: (1 - ZOOM) * (e.clientY - (r.y + r.height / 2)),
    });
    setZoom(ZOOM);
  };

  const onImgPointerDown = (e) => {
    if (zoom === 1) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, pan: { ...pan }, moved: false };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onImgPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 8) d.moved = true;
    // Panning may not carry the image further than its own scaled overflow.
    const el = imgRef.current;
    const maxX = ((ZOOM - 1) * el.offsetWidth) / 2;
    const maxY = ((ZOOM - 1) * el.offsetHeight) / 2;
    setPan({
      x: clamp(d.pan.x + dx, -maxX, maxX),
      y: clamp(d.pan.y + dy, -maxY, maxY),
    });
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      onClick={onClose}
      className="fixed inset-0 z-50 flex animate-fade-in touch-none select-none
                 items-center justify-center bg-[var(--scrim-strong)] p-4"
    >
      <img
        ref={imgRef}
        src={src}
        alt=""
        draggable={false}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onImgPointerDown}
        onPointerMove={onImgPointerMove}
        onPointerUp={onImgPointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragging(false);
        }}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          // No transition mid-drag, or the pan lags a frame behind the finger.
          transition: dragging ? "none" : "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
        className={`max-h-[92vh] max-w-[94vw] rounded-lg object-contain shadow-2xl
                    ${zoom === 1 ? "cursor-zoom-in" : dragging ? "cursor-grabbing" : "cursor-zoom-out"}`}
      />
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="Close"
        aria-label="Close preview"
        className="absolute right-4 top-4 rounded-full bg-[var(--overlay-chip)] p-2
                   text-[var(--overlay-fg)] backdrop-blur-sm
                   hover:bg-[var(--overlay-chip-hover)]"
      >
        <IconX className="h-5 w-5" />
      </button>
    </div>,
    document.body
  );
}

export default function PreviewableImage({ src, alt = "", className = "" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        src={src}
        alt={alt}
        onClick={() => setOpen(true)}
        className={`cursor-zoom-in ${className}`}
      />
      {open && <Lightbox src={src} onClose={() => setOpen(false)} />}
    </>
  );
}
