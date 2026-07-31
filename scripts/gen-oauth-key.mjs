// Mint the Authorization Server's ES256 signing key (server/oauth.ts). Prints ONE private JWK
// on stdout — everything else goes to stderr, so it pipes straight into wrangler:
//
//   node scripts/gen-oauth-key.mjs | npx wrangler secret put OAUTH_SIGNING_KEY
//
// Worker secrets are write-only: you cannot read this value back, and a graceful rotation needs
// the OLD key to keep publishing its public half. So also keep the output in a password manager
// — losing it means an abrupt swap and up to an hour of 401s while cached assertions age out.
//
// `kid` is the key's RFC 7638 thumbprint: derived from the key itself, so it is stable, unique
// per key, and impossible to accidentally reuse across a rotation (which would make the resource
// server pick the wrong public key).
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose'

const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })
const kid = await calculateJwkThumbprint(await exportJWK(publicKey))
const jwk = { ...(await exportJWK(privateKey)), alg: 'ES256', use: 'sig', kid }

console.error(`kid=${kid} (public; safe to log — it appears in every token header)`)
console.error('stdout below is PRIVATE key material: do not commit it, echo it, or paste it into chat.')
console.log(JSON.stringify(jwk))
