import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function defaultPaths() {
  return {
    envFile: path.join(serverDir, '.env'),
    dataDir: path.join(serverDir, 'data'),
    clientDist: path.resolve(serverDir, '..', 'client', 'dist'),
  }
}
