// Zagon: node --test site/vault.test.js
const test = require("node:test");
const assert = require("node:assert");
const Vault = require("./vault.js");

test("sifriranje in desifriranje s pravim geslom", async () => {
  const blob = await Vault.encrypt('{"holdings":[1,2,3]}', "skrivno-geslo");
  assert.strictEqual(blob.v, 1);
  assert.ok(!JSON.stringify(blob).includes("holdings"));
  const { text, key } = await Vault.decryptWithPassword(blob, "skrivno-geslo");
  assert.strictEqual(text, '{"holdings":[1,2,3]}');

  // zapomnjen kljuc deluje brez gesla
  const stored = await Vault.exportKey(key);
  const again = await Vault.decryptWithKey(blob, await Vault.importKey(stored));
  assert.strictEqual(again, text);
});

test("napacno geslo zavrne", async () => {
  const blob = await Vault.encrypt("abc", "pravo-geslo");
  await assert.rejects(Vault.decryptWithPassword(blob, "napacno-geslo"));
});

test("vsako sifriranje ima svojo sol in iv", async () => {
  const a = await Vault.encrypt("x", "geslo1234");
  const b = await Vault.encrypt("x", "geslo1234");
  assert.notStrictEqual(a.salt, b.salt);
  assert.notStrictEqual(a.ct, b.ct);
});
