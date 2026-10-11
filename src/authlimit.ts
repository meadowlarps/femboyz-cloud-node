type AuthFailures = { fails: number, lastFail: number, blockedUntil: number }

export type AuthLimitConfig = {
    max_fails: () => number         // getters so tests and env reloads see current values
    block_ms: () => number          // block duration, also the failure-counter window
    max_tracked_ips?: number
}

export type AuthLimit = ReturnType<typeof authlimit_create>

// ponytail: state is per-process and lost on restart, and the size cap means a large
// IPv6 pool could evict its own block — good enough for one API process, revisit with
// a shared store before horizontal scaling.
export function authlimit_create(config: AuthLimitConfig) {
    const max_tracked_ips = config.max_tracked_ips ?? 10_000
    const failures = new Map<string, AuthFailures>()

    function sweep(now: number) {
        for (const [ip, entry] of failures)
            if (entry.blockedUntil <= now && entry.lastFail + config.block_ms() <= now)
                failures.delete(ip)
    }

    function evict_oldest() {
        let oldest_ip: string | undefined
        let oldest_fail = Infinity
        for (const [ip, entry] of failures)
            if (entry.lastFail < oldest_fail) { oldest_fail = entry.lastFail; oldest_ip = ip }
        if (oldest_ip !== undefined) failures.delete(oldest_ip)
    }

    return {
        block_remaining_ms(ip: string, now = Date.now()): number {
            const entry = failures.get(ip)
            if (!entry) return 0
            return Math.max(0, entry.blockedUntil - now)
        },

        register_failure(ip: string, now = Date.now()): { blocked: boolean, blockedUntil: number } {
            sweep(now)

            const entry = failures.get(ip) ?? { fails: 0, lastFail: 0, blockedUntil: 0 }
            if (!failures.has(ip)) {
                if (failures.size >= max_tracked_ips) evict_oldest()
                failures.set(ip, entry)
            }

            entry.fails++
            entry.lastFail = now

            if (entry.fails < config.max_fails()) return { blocked: false, blockedUntil: entry.blockedUntil }

            entry.fails = 0
            entry.blockedUntil = now + config.block_ms()
            return { blocked: true, blockedUntil: entry.blockedUntil }
        },

        clear(ip: string) {
            failures.delete(ip)
        },

        // test-only: drop all tracked IPs so cases start from a clean map
        _reset() {
            failures.clear()
        }
    }
}
