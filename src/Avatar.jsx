import { initial } from "./format.js";

/**
 * A person, as a circle.
 *
 * Their picture if they've set one, the first letter of their name if they
 * haven't. Both are drawn at the same size in the same place, so a screen
 * doesn't reflow when someone adds one.
 */
export default function Avatar({ user, size = 32, className = "" }) {
  const style = { width: size, height: size };

  if (user?.avatar)
    return (
      <img
        src={user.avatar}
        alt=""
        style={style}
        className={`shrink-0 rounded-full object-cover ${className}`}
      />
    );

  return (
    <div
      style={{ ...style, fontSize: Math.round(size * 0.4) }}
      className={`flex shrink-0 items-center justify-center rounded-full
                  bg-[var(--accent)] font-medium text-[var(--accent-fg)] ${className}`}
    >
      {initial(user?.username)}
    </div>
  );
}
