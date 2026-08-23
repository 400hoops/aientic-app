/**
 * Copy text to the clipboard on any origin the app can run on.
 *
 * navigator.clipboard only exists on secure origins — a deployment reached
 * as http://lan-ip:8080 doesn't have one. The execCommand("copy") fallback
 * still works there, so a "copy" button should never be a silent no-op.
 */
export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied or failed — fall through to the fallback.
    }
  }
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  helper.remove();
  return ok;
}
