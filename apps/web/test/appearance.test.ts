import assert from "node:assert/strict";
import test from "node:test";
import { followAppearance } from "../src/appearance.ts";

function systemPreference() {
  const events = new EventTarget();
  let matches = false;
  const media = {
    get matches() { return matches; },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } as MediaQueryList;
  return {
    media,
    change(dark: boolean) {
      matches = dark;
      events.dispatchEvent(new Event("change"));
    },
  };
}

test("Match device updates while the app is open and releases its listener when replaced", () => {
  const preference = systemPreference();
  const colors: boolean[] = [];
  const stop = followAppearance("system", dark => colors.push(dark), preference.media);
  preference.change(true);
  preference.change(false);
  stop?.();
  preference.change(true);
  assert.deepEqual(colors, [false, true, false]);
});

test("Light and Dark stay selected when the device theme changes", () => {
  const preference = systemPreference();
  const colors: boolean[] = [];
  followAppearance("light", dark => colors.push(dark), preference.media);
  preference.change(true);
  followAppearance("dark", dark => colors.push(dark), preference.media);
  preference.change(false);
  assert.deepEqual(colors, [false, true]);
});
