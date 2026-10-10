/*
 * Sifriranje portfelja z geslom (WebCrypto: PBKDF2-SHA256 -> AES-256-GCM).
 * Isto kodo uporabljata brskalnik (prijava) in Node 22 (sifriranje ob objavi).
 *
 * Oblika sifrirane datoteke:
 *   {"v":1,"kdf":"PBKDF2-SHA256","iter":310000,"salt":"<b64>","iv":"<b64>","ct":"<b64>"}
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Vault = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var ITER = 310000;
  var subtle = globalThis.crypto.subtle;
  var enc = new TextEncoder(), dec = new TextDecoder();

  function b64(bytes) {
    var s = "";
    bytes = new Uint8Array(bytes);
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function unb64(str) {
    var s = atob(str), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function deriveKey(password, salt, iter) {
    return subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]).then(function (base) {
      return subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt: salt, iterations: iter || ITER },
        base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    });
  }

  function encrypt(plaintext, password) {
    var salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    var iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(password, salt, ITER).then(function (key) {
      return subtle.encrypt({ name: "AES-GCM", iv: iv }, key, enc.encode(plaintext));
    }).then(function (ct) {
      return { v: 1, kdf: "PBKDF2-SHA256", iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
    });
  }

  // Vrne {text, key}; ob napacnem geslu se Promise zavrne.
  function decryptWithPassword(blob, password) {
    return deriveKey(password, unb64(blob.salt), blob.iter).then(function (key) {
      return decryptWithKey(blob, key).then(function (text) { return { text: text, key: key }; });
    });
  }

  function decryptWithKey(blob, key) {
    return subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, key, unb64(blob.ct))
      .then(function (pt) { return dec.decode(pt); });
  }

  // Za "zapomni si me": shranimo izpeljani kljuc (ne gesla).
  function exportKey(key) {
    return subtle.exportKey("raw", key).then(b64);
  }
  function importKey(str) {
    return subtle.importKey("raw", unb64(str), { name: "AES-GCM" }, true, ["decrypt"]);
  }

  return {
    encrypt: encrypt, decryptWithPassword: decryptWithPassword, decryptWithKey: decryptWithKey,
    exportKey: exportKey, importKey: importKey,
  };
});
