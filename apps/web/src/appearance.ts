export type AppearanceMode = "light" | "dark" | "system";

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === "light" || value === "dark" || value === "system";
}

export function followAppearance(
  mode: AppearanceMode,
  apply: (dark: boolean) => void,
  preference: MediaQueryList = window.matchMedia("(prefers-color-scheme: dark)"),
) {
  if (mode !== "system") {
    apply(mode === "dark");
    return;
  }
  const update = () => apply(preference.matches);
  update();
  preference.addEventListener("change", update);
  return () => preference.removeEventListener("change", update);
}
