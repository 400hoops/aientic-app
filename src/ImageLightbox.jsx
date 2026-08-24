import { useEffect, useState } from "react";
import { IconX } from "./Icons.jsx";

/**
 * Chat image viewer.
 *
 * An image rendered through PreviewableImage opens a full-screen
 * lightbox; Escape, the close button, or clicking the backdrop
 * dismisses it. The backdrop locks page scroll while open.
 */

function Lightbox({ src, onClose }) {
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

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-70 p-4"
    >
      <img
        src={src}
        alt=""
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] max-w-[94vw] rounded-lg object-contain shadow-2xl"
      />
      <button
        onClick={onClose}
        title="Close"
        className="absolute right-4 top-4 rounded-full bg-black bg-opacity-50 p-2
                   text-white/80 hover:bg-opacity-70 hover:text-white"
      >
        <IconX className="h-5 w-5" />
      </button>
    </div>
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
