import { pathToFileURL } from "node:url"
import { stalwart_signature_default, stalwart_user_account_ids } from "./stalwart.js"

/** Gives existing mailboxes the default signature where they have none. */
export async function signature_backfill(): Promise<{ accounts: number, identities: number }> {
    let identities = 0
    const ids = await stalwart_user_account_ids()
    for (const id of ids) identities += await stalwart_signature_default(id)
    return { accounts: ids.length, identities }
}

// `npm run mail:signatures` once after deploying; signups get it themselves.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    console.log(await signature_backfill())
