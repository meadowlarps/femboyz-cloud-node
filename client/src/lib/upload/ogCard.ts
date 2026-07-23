import { ImageResponse } from '@vercel/og'
import sharp from 'sharp'
import type { FileData, UploadData } from './downloader'
import { buildUploadPreviewText } from './preview'

export const OG_CARD_WIDTH = 720
export const OG_CARD_HEIGHT = 600
export const OG_LEAD_WIDTH = 640
export const OG_LEAD_HEIGHT = 360
export const MAX_OG_SOURCE_BYTES = 25 * 1024 * 1024
export const MAX_OG_SOURCE_PIXELS = 40_000_000

const supportedLeadMimes = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif',
    'image/gif',
    'image/tiff'
])

type Style = Record<string, string | number>

export type OgElement = {
    type: string
    props: {
        children?: OgNode | OgNode[]
        style?: Style
        src?: string
        width?: number
        height?: number
    }
}

type OgNode = OgElement | string | number

function element(type: string, props: Omit<OgElement['props'], 'children'> = {}, ...children: OgNode[]): OgElement {
    return {
        type,
        props: {
            ...props,
            ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children })
        }
    }
}

export function selectLeadImage(upload: UploadData): FileData | null {
    const first = upload.type === 'album' ? upload.files[0] : undefined
    return first?.mime.toLowerCase().startsWith('image/') ? first : null
}

export function canNormalizeLeadImage(file: FileData): boolean {
    return file.size <= MAX_OG_SOURCE_BYTES && supportedLeadMimes.has(file.mime.toLowerCase())
}

export async function normalizeLeadImage(input: ArrayBuffer | Uint8Array): Promise<string | null> {
    try {
        const png = await sharp(Buffer.from(input instanceof ArrayBuffer ? new Uint8Array(input) : input), {
            animated: false,
            limitInputPixels: MAX_OG_SOURCE_PIXELS
        })
            .rotate()
            .resize(OG_LEAD_WIDTH, OG_LEAD_HEIGHT, { fit: 'cover', position: 'centre' })
            .png()
            .toBuffer()

        return `data:image/png;base64,${png.toString('base64')}`
    } catch {
        return null
    }
}

export function fileTypeLabel(file: FileData): string {
    const extension = file.filename.includes('.') ? file.filename.split('.').pop()?.toUpperCase() ?? '' : ''
    if (/^[A-Z0-9]{1,5}$/.test(extension)) return extension

    const mime = file.mime.toLowerCase()
    if (mime === 'application/pdf') return 'PDF'
    if (mime.includes('zip') || mime.includes('archive') || mime.includes('compressed')) return 'ZIP'
    if (mime.startsWith('audio/')) return 'AUD'
    if (mime === 'image/gif') return 'GIF'
    if (mime.startsWith('image/')) return 'IMG'
    if (mime.startsWith('video/')) return 'VID'
    return 'FILE'
}

export function buildTileLabels(files: FileData[], excludedIndex: number | null = null): string[] {
    return files
        .filter(file => file.index !== excludedIndex)
        .slice(0, 6)
        .map(fileTypeLabel)
}

export function mediaTypeLabel(file: FileData): string {
    if (file.mime.toLowerCase() === 'image/gif') return 'GIF'
    if (file.mime.toLowerCase().startsWith('image/')) return 'IMG'
    if (file.mime.toLowerCase().startsWith('video/')) return 'VID'
    return 'FILE'
}

export function fileTypeColor(file: FileData): string {
    const mime = file.mime.toLowerCase()
    if (mime.startsWith('image/')) return '#66b8e8'
    if (mime.startsWith('video/')) return '#c78be8'
    if (mime.startsWith('audio/')) return '#e887b3'
    if (mime === 'application/pdf') return '#e86f77'
    if (/zip|compressed|archive|tar|rar|7z|gzip/.test(mime)) return '#e6b85f'
    if (mime.startsWith('text/') || /json|xml|document|word|sheet|presentation/.test(mime)) return '#75cda5'
    return '#918a8d'
}

function tile(label: string, color: string, width = 190, height = 190): OgElement {
    return element('div', {
        style: {
            alignItems: 'center',
            border: `2px solid ${color}`,
            color,
            display: 'flex',
            fontSize: 34,
            height,
            justifyContent: 'center',
            width
        }
    }, label)
}

function safeCardText(value: string, maxLength: number): string {
    const clean = value
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .replace(/[^\u0020-\u017f\u0400-\u045f]/gu, '?')
        .trim()
    const chars = Array.from(clean)
    return chars.length <= maxLength ? clean : `${chars.slice(0, maxLength - 3).join('')}...`
}

function header(upload: UploadData, siteName: string): OgElement {
    const text = buildUploadPreviewText(upload, siteName)
    return element('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8
        }
    },
    element('div', {
        style: {
            color: '#ffffff',
            display: 'flex',
            fontSize: 44,
            lineHeight: 1
        }
    }, safeCardText(text.title, 70)),
    element('div', {
        style: {
            color: '#a7a7a7',
            display: 'flex',
            fontSize: 27,
            lineHeight: 1.15
        }
    }, safeCardText(text.description, 130)))
}

function tiles(files: FileData[]): OgElement {
    return element('div', {
        style: {
            alignContent: 'flex-start',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 20,
            width: OG_LEAD_WIDTH
        }
    }, ...files.slice(0, 6).map(file => tile(fileTypeLabel(file), fileTypeColor(file))))
}

function albumContent(upload: UploadData, leadImageDataUri: string | null): OgElement {
    const first = upload.files[0]
    if (!first) return element('div')

    const lead = selectLeadImage(upload)
    return lead && leadImageDataUri
        ? element('img', {
            src: leadImageDataUri,
            width: OG_LEAD_WIDTH,
            height: OG_LEAD_HEIGHT,
            style: {
                height: OG_LEAD_HEIGHT,
                objectFit: 'cover',
                width: OG_LEAD_WIDTH
            }
        })
        : tile(mediaTypeLabel(first), fileTypeColor(first), OG_LEAD_WIDTH, OG_LEAD_HEIGHT)
}

export function buildOgCardElement(upload: UploadData, siteName: string, leadImageDataUri: string | null): OgElement {
    const content = upload.type === 'album'
        ? albumContent(upload, leadImageDataUri)
        : tiles(upload.files)

    return element('div', {
        style: {
            alignItems: 'stretch',
            background: '#000000',
            color: '#ffffff',
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
            height: '100%',
            padding: 40,
            width: '100%'
        }
    }, header(upload, siteName), content)
}

function buildFallbackElement(upload: UploadData, siteName: string): OgElement {
    const text = buildUploadPreviewText(upload, siteName)
    return element('div', {
        style: {
            alignItems: 'center',
            background: '#000000',
            color: '#ffffff',
            display: 'flex',
            flexDirection: 'column',
            fontSize: 52,
            gap: 18,
            height: '100%',
            justifyContent: 'center',
            width: '100%'
        }
    },
    safeCardText(text.title, 70),
    element('div', { style: { color: '#a7a7a7', display: 'flex', fontSize: 28 } },
        safeCardText(text.description, 130)))
}

async function render(elementTree: OgElement): Promise<ArrayBuffer> {
    // @vercel/og accepts React-shaped objects at runtime; React itself is not required.
    const response = new ImageResponse(elementTree as never, {
        width: OG_CARD_WIDTH,
        height: OG_CARD_HEIGHT
    })
    return response.arrayBuffer()
}

export async function renderOgCard(upload: UploadData, siteName: string, leadImageDataUri: string | null): Promise<ArrayBuffer> {
    try {
        return await render(buildOgCardElement(upload, siteName, leadImageDataUri))
    } catch {
        return render(buildFallbackElement(upload, siteName))
    }
}
