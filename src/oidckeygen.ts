import { generateKeyPairSync, randomBytes } from "node:crypto"
import { pathToFileURL } from "node:url"

/** A new RS256 signing key as a private JWK, for OIDC_JWKS_FILE. */
export function oidc_jwk_generate(): Record<string, unknown> {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const jwk = privateKey.export({ format: "jwk" })
    return { ...jwk, kid: randomBytes(8).toString("hex"), alg: "RS256", use: "sig" }
}

// `npm run oidc:keygen` prints one key; DEPLOYMENT.md 14.2 describes rotation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    console.log(JSON.stringify(oidc_jwk_generate(), null, 2))
