/** The Playfair Display wordmark, used in the sidebar and on the login page. */
export default function Wordmark({ size = 22, className = "" }) {
  return (
    <span
      className={`wordmark leading-none tracking-tight text-[var(--text)] ${className}`}
      style={{ fontSize: size }}
    >
      Aientic
    </span>
  );
}
