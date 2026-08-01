/**
 * SSR `load` functions reach the API over localhost, so without these headers the API sees
 * 127.0.0.1 as `request.ip` for every server-rendered request and real client IPs are lost.
 *
 * nginx already builds the chain (`$proxy_add_x_forwarded_for` appends the real peer on the
 * right), so passing it through unchanged is enough — and it is not spoofable, because the
 * API resolves the rightmost untrusted entry, which is the address nginx appended itself.
 *
 * Browser-side callers must never send these; only pass headers from an incoming SSR request.
 */
export function forwardedHeaders(request: Request): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const name of ['x-forwarded-for', 'x-real-ip', 'x-forwarded-proto']) {
        const value = request.headers.get(name)
        if (value) headers[name] = value
    }
    return headers
}
