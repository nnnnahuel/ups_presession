import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/checkin.html", import.meta.url), "utf8");
const scannerCode = html.slice(html.indexOf("      function argentinaDayRange("), html.indexOf("      function startScanLoop("));

async function scan(at, events) {
  const inserts = [];
  const statuses = [];
  const context = vm.createContext({
    Intl,
    Date: class extends Date { static now() { return Date.parse(at); } },
    isSaving: false, lastText: "", cooldownUntil: 0,
    SUPABASE_URL: "https://example.test", SUPABASE_ANON_KEY: "test-key",
    manualQrEl: { value: "" },
    setStatus: (message, status) => statuses.push({ message, status }),
    setTemporaryStatus: (message, status) => statuses.push({ message, status }),
    buildSuccessMessage: (_result, fallback) => fallback,
    beepSuccess() {},
    fetch: async (url, options) => {
      if (options.method === "POST") {
        inserts.push(JSON.parse(options.body));
        return { ok: true };
      }
      const query = new URL(url).searchParams;
      if (url.includes("/athletes?")) {
        return { ok: true, json: async () => [{ full_name: "Facundo Velazquez" }] };
      }
      assert.equal(query.get("qr_code"), "eq.A-712-FacundoVelazquez");
      assert.equal(query.get("source"), "eq.qr_scanner");
      const bounds = query.getAll("checked_in_at");
      assert.equal(bounds.length, 2);
      const start = Date.parse(bounds.find(value => value.startsWith("gte.")).slice(4));
      const end = Date.parse(bounds.find(value => value.startsWith("lt.")).slice(3));
      return { ok: true, json: async () => events.filter(value => Date.parse(value) >= start && Date.parse(value) < end).map(() => ({ id: "existing" })) };
    }
  });
  vm.runInContext(scannerCode, context);
  await context.saveCheckin("A-712-FacundoVelazquez");
  assert.notEqual(statuses.at(-1).status, "err");
  return { inserts, status: statuses.at(-1).status };
}

test("yesterday's late check-in does not block the next Argentine morning", async () => {
  const result = await scan("2026-09-05T12:07:49Z", ["2026-09-05T01:15:18.019Z"]);
  assert.equal(result.status, "ok");
  assert.equal(result.inserts.length, 1);
  assert.equal(result.inserts[0].checked_in_at, "2026-09-05T12:07:49.000Z");
});

test("same Argentine day stays blocked across UTC midnight", async () => {
  const result = await scan("2026-09-05T01:15:18Z", ["2026-09-04T12:00:00Z"]);
  assert.equal(result.status, "warn");
  assert.equal(result.inserts.length, 0);
});

test("local midnight starts a new day, including year rollover", async () => {
  for (const [at, previous] of [
    ["2026-09-05T03:00:00Z", "2026-09-05T02:59:59.999Z"],
    ["2027-01-01T03:00:00Z", "2027-01-01T02:59:59.999Z"]
  ]) {
    assert.equal((await scan(at, [previous])).status, "ok");
    assert.equal((await scan(at, [at])).status, "warn");
  }
});

test("future-day events are outside today's duplicate window", async () => {
  assert.equal((await scan("2026-09-05T12:00:00Z", ["2026-09-06T03:00:00Z"])).status, "ok");
});
