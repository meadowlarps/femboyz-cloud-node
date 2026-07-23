import type { FileData, UploadData } from './downloader'

export const OG_CARD_VERSION = '1'

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

export function buildUploadPreview(upload: UploadData, origin: string, userAgent: string | null): UploadPreview {
    const countLabel = buildUploadCountLabel(upload)
    const title = upload.meta.title.trim()
    const description = upload.meta.desc.trim()
    const canonicalUrl = new URL(`/${upload.id}`, origin)
    const siteName = canonicalUrl.hostname
    const cardImageUrl = hasGeneratedCard(upload)
        ? new URL(`/${upload.id}/og.png?v=${OG_CARD_VERSION}`, origin).href
        : null
    const onlyFile = upload.type === 'album' && upload.files.length === 1 ? upload.files[0] : undefined
    const image = upload.type === 'album'
        ? upload.files.find(file => file.mime.startsWith('image/')) ?? null
        : null
    const video = upload.type === 'album' && !image
        ? upload.files.find(file => file.mime.startsWith('video/')) ?? null
        : null

    return {
        title: title || countLabel,
        description: description || (title ? `${countLabel} via ${siteName}` : `via ${siteName}`),
        siteName,
        canonicalUrl: canonicalUrl.href,
        cardImageUrl,
        cardImageAlt: cardImageUrl ? `${title || countLabel}: ${countLabel} via ${siteName}` : null,
        image,
        video,
        redirectUrl: isPreviewCrawler(userAgent)
            && onlyFile
            && (onlyFile.mime.startsWith('image/') || onlyFile.mime.startsWith('video/'))
            ? onlyFile.url
            : null
    }
}
