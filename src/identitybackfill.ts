import { pathToFileURL } from "node:url"
import { stalwart_identity_defaults, stalwart_user_account_ids } from "./stalwart.js"

/** Gives existing mailboxes the identity defaults (sender name, signature) where unset. */
export async function identity_backfill(): Promise<{ accounts: number, identities: number }> {
    let identities = 0
    const ids = await stalwart_user_account_ids()
    for (const id of ids) identities += await stalwart_identity_defaults(id)
    return { accounts: ids.length, identities }
}

// `npm run mail:identities` once after deploying; signups get them themselves.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    console.log(await identity_backfill())
