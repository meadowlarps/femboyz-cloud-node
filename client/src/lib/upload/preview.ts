import type { FileData, UploadData } from './downloader'

export const OG_CARD_VERSION = '3'

export type UploadPreview = {
    title: string
    description: string
    siteName: string
    canonicalUrl: string
    cardImageUrl: string | null
    cardImageAlt: string | null
    suppressMetaText: boolean
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

export function buildUploadPreviewText(upload: UploadData, siteName: string) {
    const countLabel = buildUploadCountLabel(upload)
    const customTitle = upload.meta.title.trim()
    return {
        title: customTitle || countLabel,
        description: upload.meta.desc.trim()
            || (customTitle ? `${countLabel} via ${siteName}` : `via ${siteName}`)
    }
}

export function buildUploadPreview(upload: UploadData, origin: string, userAgent: string | null): UploadPreview {
    const countLabel = buildUploadCountLabel(upload)
    const canonicalUrl = new URL(`/${upload.id}`, origin)
    const siteName = canonicalUrl.hostname
    const text = buildUploadPreviewText(upload, siteName)
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
        suppressMetaText: cardImageUrl !== null && previewCrawler,
        image,
        video,
        redirectUrl: previewCrawler
            && onlyFile
            && (onlyFile.mime.startsWith('image/') || onlyFile.mime.startsWith('video/'))
            ? onlyFile.url
            : null
    }
}
