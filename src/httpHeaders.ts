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
