import { pathToFileURL } from "node:url"
import { envs } from "./config.js"
import { closeDB, getDB, runDB } from "./database.js"
import { stalwart_identity_defaults } from "./stalwart.js"

/**
 * Gives existing mailboxes the identity defaults (sender name, signature) where unset.
 * Mailboxes come from our users: Stalwart overwrites account descriptions on OIDC login.
 */
export async function identity_backfill(): Promise<{ accounts: number, identities: number }> {
    const users = await getDB().collection(envs.MDB_COLLECTION_USERS)
        .find({ "services.mail.stalwart_id": { $type: "string" } }, { projection: { "services.mail.stalwart_id": 1 } })
        .toArray()
    let identities = 0
    for (const user of users) identities += await stalwart_identity_defaults(user.services.mail.stalwart_id)
    return { accounts: users.length, identities }
}

// `npm run mail:identities` once after deploying; signups get them themselves.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await runDB()
    console.log(await identity_backfill())
    closeDB()
}
