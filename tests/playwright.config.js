// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: ".",
  testMatch: "*.spec.js",
  timeout: 30_000,
  fullyParallel: false, // each test launches its own extension-loaded browser profile — keep sequential, simple, and easy to read failures from
  reporter: [["list"]],
});
