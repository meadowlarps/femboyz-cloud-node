/**
 * Build a Content-Disposition value without putting user-controlled Unicode or
 * control characters directly into an HTTP header.
 */
export function inlineContentDisposition(filename: string): string {
    const safeFilename = filename
        .toWellFormed()
        .replace(/[\u0000-\u001f\u007f\\/]/g, "_")

    const fallback = safeFilename
        .replace(/[^\x20-\x7e]/gu, "_")
        .replace(/(["])/g, "\\$1")

    const encoded = encodeURIComponent(safeFilename)
        .replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)

    return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

export function parseByteRange(header: string | undefined, size: number): { start: number, end: number } | undefined {
    if (header === undefined) return undefined
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("Invalid file size")

    const match = /^bytes=(\d*)-(\d*)$/.exec(header)
    const first = match?.[1]
    const last = match?.[2]
    if (!match || (!first && !last) || size === 0) throw new RangeError("Invalid byte range")

    if (!first) {
        const suffixLength = Number(last)
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new RangeError("Invalid byte range")
        return { start: Math.max(0, size - suffixLength), end: size - 1 }
    }

    const start = Number(first)
    const requestedEnd = last ? Number(last) : size - 1
    if (!Number.isSafeInteger(start)
        || !Number.isSafeInteger(requestedEnd)
        || start >= size
        || requestedEnd < start)
        throw new RangeError("Invalid byte range")

    return { start, end: Math.min(requestedEnd, size - 1) }
}
