import test from "node:test";
import assert from "node:assert/strict";
import { startWeatherLocationRefresh } from "../app/weather-location.ts";
import { resolveWeatherLocationName } from "../app/weather-location-name.ts";

function harness(location = null) {
  const loads = [], failures = [], fixes = [];
  let tick, cleared = false, visible = true;
  const stop = startWeatherLocationRefresh({
    location,
    geolocation: { getCurrentPosition(ok, failed, options) { fixes.push({ ok, failed, options }); } },
    load: async (...values) => { loads.push(values); },
    failed: status => failures.push(status), visible: () => visible,
    interval: callback => { tick = callback; return 42; },
    clearInterval: id => { assert.equal(id, 42); cleared = true; },
  });
  return { loads, failures, fixes, stop, tick: () => tick(), hidden: () => { visible = false; }, cleared: () => cleared };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test("each refresh obtains new coordinates and does not overlap location requests", async () => {
  const h = harness();
  assert.equal(h.fixes.length, 1);
  h.tick();
  assert.equal(h.fixes.length, 1);
  h.fixes[0].ok({ coords: { latitude: -36, longitude: 174 } });
  await settle();
  h.tick();
  h.fixes[1].ok({ coords: { latitude: -41, longitude: 175 } });
  await settle();
  assert.deepEqual(h.loads, [[-36, 174, ""], [-41, 175, ""]]);
  for (const fix of h.fixes) {
    assert.equal(fix.options.enableHighAccuracy, true);
    assert.equal(fix.options.maximumAge, 0);
    assert.equal(fix.options.timeout, 20_000);
  }
  h.stop();
});
test("closing during permission prompt cannot fetch or restart timers", async () => {
  const h = harness();
  h.stop();
  h.fixes[0].ok({ coords: { latitude: 1, longitude: 2 } });
  h.tick();
  await settle();
  assert.deepEqual(h.loads, []);
  assert.equal(h.cleared(), true);
  assert.equal(h.fixes.length, 1);
});
test("saved city bypasses device permission and hidden pages do not locate", async () => {
  const h = harness({ latitude: 1, longitude: 2, name: "Saved city" });
  await settle();
  assert.deepEqual(h.loads, [[1, 2, "Saved city"]]);
  assert.equal(h.fixes.length, 0);
  h.hidden(); h.tick();
  assert.equal(h.loads.length, 1);
  h.stop();
});
test("denial is recoverable and late errors after cleanup are ignored", () => {
  const h = harness();
  h.fixes[0].failed({ code: 1 });
  assert.deepEqual(h.failures, ["denied"]);
  h.tick();
  assert.equal(h.fixes.length, 2);
  h.stop(); h.fixes[1].failed({ code: 2 });
  assert.deepEqual(h.failures, ["denied"]);
});

test("Hamilton coordinates resolve to a town name without sending exact coordinates", async () => {
  const name = await resolveWeatherLocationName(-37.787123, 175.279345, { fetch: async (url, options) => {
    assert.equal(url, "/api/weather/location?latitude=-37.787&longitude=175.279");
    assert.equal(options.credentials, "same-origin");
    return Response.json({ name: " Hamilton " });
  } });
  assert.equal(name, "Hamilton");
});

test("unavailable or malformed town names leave the forecast's current-location fallback usable", async () => {
  for (const data of [{ name: null }, { name: 123 }, {}, { timezone: "Pacific/Auckland" }, { name: " " }]) {
    assert.equal(await resolveWeatherLocationName(-37.787, 175.279, { fetch: async () => Response.json(data) }), null);
  }
  assert.equal(await resolveWeatherLocationName(-37.787, 175.279, { fetch: async () => new Response("", { status: 503 }) }), null);
  assert.equal(await resolveWeatherLocationName(-37.787, 175.279, { fetch: async () => { throw new Error("Offline"); } }), null);
});

test("invalid coordinates and cancelled requests cannot look up another location", async () => {
  let requests = 0;
  const unavailable = async () => { requests++; throw new Error("Unexpected request"); };
  for (const coordinates of [[NaN, 1], [91, 1], [1, 181]])
    assert.equal(await resolveWeatherLocationName(...coordinates, { fetch: unavailable }), null);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await resolveWeatherLocationName(1, 2, { signal: controller.signal, fetch: unavailable }), null);
  assert.equal(requests, 0);
  const active = new AbortController();
  const name = resolveWeatherLocationName(1, 2, { signal: active.signal, fetch: async (_url, { signal }) => {
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
  } });
  active.abort();
  assert.equal(await name, null);
});
