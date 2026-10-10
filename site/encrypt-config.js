#!/usr/bin/env node
// Zasifrira portfelj za objavo na strani.
// Uporaba: SITE_PASSWORD=... node site/encrypt-config.js config.json _site/config.enc.json
const fs = require("node:fs");
const Vault = require("./vault.js");

const [src, dst] = process.argv.slice(2);
const password = process.env.SITE_PASSWORD || "";
if (!src || !dst) {
  console.error("Uporaba: node site/encrypt-config.js <config.json> <izhod.enc.json>");
  process.exit(2);
}
if (password.length < 8) {
  console.error("SITE_PASSWORD manjka ali je krajse od 8 znakov. Dodaj ga v Settings -> Secrets and variables -> Actions.");
  process.exit(1);
}
const text = fs.readFileSync(src, "utf8");
JSON.parse(text); // preveri, da je config veljaven JSON
Vault.encrypt(text, password).then((blob) => {
  fs.writeFileSync(dst, JSON.stringify(blob));
  console.log("Zasifrirano:", dst);
});
