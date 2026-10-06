// Entry point. Checks the Node.js version first, so old versions get a clear message instead of a crash.
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`\nThis project needs Node.js 22.13 or newer (you have ${process.versions.node}).`)
  console.error('Download the LTS version from https://nodejs.org, install it, then run again.\n')
  process.exit(1)
}
await import('./index.js')
