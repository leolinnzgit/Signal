import test from "node:test";
import assert from "node:assert/strict";
import { localRedactPii, analyzeAndRedactPii } from "../app/privacy-shield.ts";

test("localRedactPii masks emails, phone numbers, and credit cards", () => {
  const input = "Contact John at john.doe@example.com or 021-555-4321, card: 4111-2222-3333-4444.";
  const result = localRedactPii(input);

  assert.equal(result.hasPii, true);
  assert.equal(result.entities.length, 3);
  assert.ok(!result.redactedText.includes("john.doe@example.com"));
  assert.ok(!result.redactedText.includes("021-555-4321"));
  assert.ok(!result.redactedText.includes("4111-2222-3333-4444"));
  assert.ok(result.redactedText.includes("Contact John at"));
  assert.ok(result.entities.some((e) => e.category === "Email"));
  assert.ok(result.entities.some((e) => e.category === "PhoneNumber"));
  assert.ok(result.entities.some((e) => e.category === "CreditCardNumber"));
});

test("localRedactPii preserves safe clean text", () => {
  const safe = "The quick brown fox jumps over the lazy dog in Wellington, New Zealand.";
  const result = localRedactPii(safe);

  assert.equal(result.hasPii, false);
  assert.equal(result.entities.length, 0);
  assert.equal(result.redactedText, safe);
});

test("analyzeAndRedactPii falls back to local redact on server failure", async () => {
  const mockFetcher = async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  });

  const result = await analyzeAndRedactPii("Call me at 027-111-2222", mockFetcher);
  assert.equal(result.hasPii, true);
  assert.ok(!result.redactedText.includes("027-111-2222"));
});
