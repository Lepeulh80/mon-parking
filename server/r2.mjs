// Cloudflare R2 via son API compatible S3. Le secret ne quitte jamais le
// serveur : le navigateur reçoit une URL PUT présignée (10 min) et téléverse
// directement dans le bucket, sans transiter par Render.
//
// Le SDK est chargé à la demande : les fonctions pures (mediaKey, allowedType,
// r2Config) restent testables même sans SDK installé.
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ALLOWED = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/avif', 'avif']])

export function r2Config(env = process.env) {
  const account = String(env.R2_ACCOUNT_ID || '').trim()
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim()
  const bucket = String(env.R2_BUCKET || '').trim()
  if (!account || !accessKeyId || !secretAccessKey || !bucket) return null
  return { account, accessKeyId, secretAccessKey, bucket, publicUrl: String(env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '') }
}

export function allowedType(type) {
  return ALLOWED.has(String(type || '').toLowerCase().split(';')[0].trim())
}

export function newKeyId() {
  return randomUUID()
}

// Clé d'objet : un préfixe par parking, puis par véhicule. Le suffixe porte
// l'empreinte du contenu, ce qui rend l'URL publique non devinable même si le
// bucket est exposé en lecture.
export function mediaKey(lotId, vehicleId, contentType, id, fingerprint = '') {
  const ext = ALLOWED.get(String(contentType || '').toLowerCase().split(';')[0].trim()) || 'bin'
  const clean = (value) => String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'x'
  const tag = fingerprint ? `-${createHash('sha256').update(String(fingerprint)).digest('hex').slice(0, 12)}` : ''
  return `lots/${clean(lotId)}/vehicles/${clean(vehicleId)}/${clean(id)}${tag}.${ext}`
}

let sdk = null
function loadSdk() {
  if (!sdk) {
    const core = require('@aws-sdk/client-s3')
    const signer = require('@aws-sdk/s3-request-presigner')
    sdk = { ...core, getSignedUrl: signer.getSignedUrl }
  }
  return sdk
}

export function createR2(env = process.env) {
  const config = r2Config(env)
  if (!config) return null
  let client = null
  const s3 = () => {
    if (client) return client
    const { S3Client } = loadSdk()
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.account}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: true,
    })
    return client
  }
  const publicUrl = (key) => (config.publicUrl ? `${config.publicUrl}/${key}` : null)
  return {
    config,
    publicUrl,
    async presign(key, contentType, expiresIn = 600) {
      const { PutObjectCommand, getSignedUrl } = loadSdk()
      return getSignedUrl(s3(), new PutObjectCommand({ Bucket: config.bucket, Key: key, ContentType: contentType }), { expiresIn })
    },
    async head(key) {
      const { HeadObjectCommand } = loadSdk()
      try {
        const out = await s3().send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
        return { exists: true, size: Number(out.ContentLength || 0), contentType: out.ContentType || '' }
      } catch (error) {
        return { exists: false, error: String(error?.name || error?.message || error) }
      }
    },
    async remove(key) {
      const { DeleteObjectCommand } = loadSdk()
      await s3().send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
      return true
    },
    async cors(origins) {
      const { PutBucketCorsCommand } = loadSdk()
      await s3().send(new PutBucketCorsCommand({
        Bucket: config.bucket,
        CORSConfiguration: {
          CORSRules: [{
            AllowedOrigins: origins,
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedHeaders: ['content-type'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3600,
          }],
        },
      }))
      return origins
    },
    close() { if (client) { client.destroy(); client = null } },
  }
}
