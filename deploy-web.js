const fs = require('fs')
const path = require('path')

const root = __dirname
const output = path.join(root, 'web-release')

fs.rmSync(output, { recursive: true, force: true })
fs.mkdirSync(output, { recursive: true })

for (const file of ['index.html', 'cloud-client.js', 'supabase-config.js', 'manifest.webmanifest', 'service-worker.js']) {
  fs.copyFileSync(path.join(root, file), path.join(output, file))
}

for (const directory of ['assets', 'images', 'webfonts']) {
  fs.cpSync(path.join(root, directory), path.join(output, directory), { recursive: true, force: true })
}

fs.rmSync(path.join(output, 'images', 'store-banner.jpg.png'), { force: true })

console.log('Web app prepared in ' + output)
