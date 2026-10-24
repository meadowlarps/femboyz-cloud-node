import type { FileData, UploadData } from './downloader.js'

export const OG_CARD_VERSION = '8'
export const OG_CARD_WIDTH = 1200
export const OG_CARD_HEIGHT = 630

export const FILE_KINDS = {
    video: { color: '#e0457b', singular: 'video', plural: 'videos' },
    archive: { color: '#e2a74a', singular: 'archive', plural: 'archives' },
    audio: { color: '#5fc7b0', singular: 'track', plural: 'tracks' },
    image: { color: '#6fb3e8', singular: 'image', plural: 'images' },
    document: { color: '#a49ca0', singular: 'file', plural: 'files' }
} as const

export type FileKind = keyof typeof FILE_KINDS

export function fileKind(file: FileData): FileKind {
    const mime = file.mime.toLowerCase()
    if (mime.startsWith('video/')) return 'video'
    if (mime.startsWith('audio/')) return 'audio'
    if (mime.startsWith('image/')) return 'image'
    if (/zip|compressed|archive|tar|rar|7z|gzip/.test(mime)) return 'archive'
    return 'document'
}

export function formatPreviewSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export function summarizeUploadFiles(files: FileData[]) {
    const groups = new Map<FileKind, { kind: FileKind, count: number, bytes: number }>()
    for (const file of files) {
        const kind = fileKind(file)
        const group = groups.get(kind) ?? { kind, count: 0, bytes: 0 }
        group.count++
        group.bytes += file.size
        groups.set(kind, group)
    }
    return {
        bytes: files.reduce((total, file) => total + file.size, 0),
        groups: [...groups.values()]
    }
}

export function fileKindCountLabel(kind: FileKind, count: number): string {
    return `${count} ${count === 1 ? FILE_KINDS[kind].singular : FILE_KINDS[kind].plural}`
}

export type UploadPreview = {
    title: string
    description: string
    siteName: string
    canonicalUrl: string
    cardImageUrl: string | null
    cardImageAlt: string | null
    image: FileData | null
    video: FileData | null
    redirectUrl: string | null
}

export function isPreviewCrawler(userAgent: string | null): boolean {
    return /\b(?:Discordbot|TelegramBot)\b/i.test(userAgent ?? '')
}

export function buildUploadCountLabel(upload: UploadData): string {
    if (upload.type === 'note') {
        const length = upload.note_length ?? upload.note?.length ?? 0
        return `${length.toLocaleString('en-US')} ${length === 1 ? 'character' : 'characters'}`
    }
    return upload.type === 'playlist'
        ? `${upload.files.length} ${upload.files.length === 1 ? 'track' : 'tracks'}`
        : upload.type === 'album'
            ? (upload.files.length === 1 ? '1 media item' : `${upload.files.length} media`)
            : `${upload.files.length} ${upload.files.length === 1 ? 'file' : 'files'}`
}

export function hasGeneratedCard(upload: UploadData): boolean {
    return upload.type === 'files'
        || upload.type === 'playlist'
        || (upload.type === 'album' && upload.files.length > 1)
}

export function buildUploadPreviewText(upload: UploadData) {
    const summary = summarizeUploadFiles(upload.files)
    const countLabel = buildUploadCountLabel(upload)
    const details = summary.groups.map(group => fileKindCountLabel(group.kind, group.count)).join(', ')
    const fallback = hasGeneratedCard(upload)
        ? `${countLabel} ${formatPreviewSize(summary.bytes)}${details && details !== countLabel ? `, ${details}` : ''}`
        : ''
    return {
        title: upload.meta.title.trim() || upload.id,
        description: upload.type === 'note'
            ? (upload.note_preview ?? '').replace(/\s+/g, ' ').trim()
            : upload.meta.desc.trim() || fallback
    }
}

export function buildUploadPreview(upload: UploadData, origin: string, userAgent: string | null): UploadPreview {
    const countLabel = buildUploadCountLabel(upload)
    const canonicalUrl = new URL(`/${upload.id}`, origin)
    const siteName = canonicalUrl.hostname
    const text = buildUploadPreviewText(upload)
    const cardImageUrl = hasGeneratedCard(upload)
        ? new URL(`/${upload.id}/og.png?v=${OG_CARD_VERSION}`, origin).href
        : null
    const previewCrawler = isPreviewCrawler(userAgent)
    const onlyFile = upload.type === 'album' && upload.files.length === 1 ? upload.files[0] : undefined
    const image = upload.type === 'album'
        ? upload.files.find(file => file.mime.startsWith('image/')) ?? null
        : null
    const video = upload.type === 'album' && !image
        ? upload.files.find(file => file.mime.startsWith('video/')) ?? null
        : null

    return {
        ...text,
        siteName,
        canonicalUrl: canonicalUrl.href,
        cardImageUrl,
        cardImageAlt: cardImageUrl ? `${text.title}: ${countLabel} via ${siteName}` : null,
        image,
        video,
        redirectUrl: previewCrawler
            && onlyFile
            && (onlyFile.mime.startsWith('image/') || onlyFile.mime.startsWith('video/'))
            ? onlyFile.url
            : null
    }
}
