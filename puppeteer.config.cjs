const { join } = require('path')

/** @type {import("puppeteer").Configuration} */
module.exports = {
  // Install Chrome inside the project directory so it's available at runtime.
  // Render preserves the project dir between build and runtime; $HOME/.cache is not guaranteed.
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
}
