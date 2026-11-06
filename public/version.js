/* One loader for the build label every page states at its foot.
   `/version.json` is the single source; the bundled fallback covers an offline
   desk or a cached shell, so the label never reads "undefined". */

export const APP_VERSION_FALLBACK = "1.1.0";

/** Paint `Version x.y.z` into every `.app-version-label` on the page. */
export async function loadAppVersion() {
  let version = APP_VERSION_FALLBACK;
  try {
    const response = await fetch("/version.json", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json();
      if (typeof data.version === "string" && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(data.version)) {
        version = data.version;
      }
    }
  } catch { /* retain the bundled fallback */ }
  for (const label of document.querySelectorAll(".app-version-label")) {
    label.textContent = `Version ${version}`;
  }
}
