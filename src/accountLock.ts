// Account operations run in one API process, like authlimit. Serialize related mutations
// across their awaits; reload database state after taking the lock. Revisit before scaling.
const pending = new Map<string, Promise<void>>()

export async function account_lock<T>(keys: string[], work: () => Promise<T>): Promise<T> {
    const releases: (() => void)[] = []
    try {
        for (const key of [...new Set(keys)].sort()) {
            const previous = pending.get(key) ?? Promise.resolve()
            let release!: () => void
            const next = new Promise<void>(resolve => { release = resolve })
            pending.set(key, next)
            await previous
            releases.push(() => {
                if (pending.get(key) === next) pending.delete(key)
                release()
            })
        }
        return await work()
    } finally {
        for (const release of releases.reverse()) release()
    }
}
