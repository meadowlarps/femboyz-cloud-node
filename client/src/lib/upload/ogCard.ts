import { ImageResponse } from '@vercel/og'
import sharp from 'sharp'
import type { FileData, UploadData } from './downloader'
import { buildUploadCountLabel } from './preview'

export const OG_CARD_WIDTH = 1200
export const OG_CARD_HEIGHT = 630
export const OG_LEAD_WIDTH = 760
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
    return upload.type === 'album'
        ? upload.files.find(file => file.mime.startsWith('image/')) ?? null
        : null
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

function buildMediaTileLabels(files: FileData[], excludedIndex: number | null = null): string[] {
    return files
        .filter(file => file.index !== excludedIndex)
        .slice(0, 6)
        .map(mediaTypeLabel)
}

function tile(label: string, compact = false): OgElement {
    return element('div', {
        style: {
            alignItems: 'center',
            border: '2px solid #8a8a8a',
            color: '#ffffff',
            display: 'flex',
            fontSize: compact ? 28 : 34,
            height: compact ? 104 : 130,
            justifyContent: 'center',
            width: compact ? 140 : 190
        }
    }, label)
}

function header(upload: UploadData, siteName: string): OgElement {
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
            fontSize: 48,
            lineHeight: 1
        }
    }, buildUploadCountLabel(upload).toUpperCase()),
    element('div', {
        style: {
            color: '#a7a7a7',
            display: 'flex',
            fontSize: 27
        }
    }, `via ${siteName}`))
}

function tiles(labels: string[], compact = false): OgElement {
    return element('div', {
        style: {
            alignContent: 'flex-start',
            display: 'flex',
            flexWrap: 'wrap',
            gap: compact ? 16 : 20,
            width: compact ? 296 : 610
        }
    }, ...labels.map(label => tile(label, compact)))
}

function albumContent(upload: UploadData, leadImageDataUri: string | null): OgElement {
    const lead = selectLeadImage(upload)
    if (!lead) return tiles(buildMediaTileLabels(upload.files))

    const leadVisual = leadImageDataUri
        ? element('img', {
            src: leadImageDataUri,
            width: OG_LEAD_WIDTH,
            height: OG_LEAD_HEIGHT,
            style: {
                border: '2px solid #8a8a8a',
                height: OG_LEAD_HEIGHT,
                objectFit: 'cover',
                width: OG_LEAD_WIDTH
            }
        })
        : element('div', {
            style: {
                alignItems: 'center',
                border: '2px solid #8a8a8a',
                color: '#ffffff',
                display: 'flex',
                fontSize: 52,
                height: OG_LEAD_HEIGHT,
                justifyContent: 'center',
                width: OG_LEAD_WIDTH
            }
        }, mediaTypeLabel(lead))

    return element('div', {
        style: {
            display: 'flex',
            gap: 24,
            height: OG_LEAD_HEIGHT
        }
    }, leadVisual, tiles(buildMediaTileLabels(upload.files, lead.index).slice(0, 5), true))
}

export function buildOgCardElement(upload: UploadData, siteName: string, leadImageDataUri: string | null): OgElement {
    const content = upload.type === 'album'
        ? albumContent(upload, leadImageDataUri)
        : tiles(buildTileLabels(upload.files))

    return element('div', {
        style: {
            alignItems: 'stretch',
            background: '#000000',
            color: '#ffffff',
            display: 'flex',
            height: '100%',
            justifyContent: 'center',
            padding: 28,
            width: '100%'
        }
    },
    element('div', {
        style: {
            border: '2px solid #8a8a8a',
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
            height: '100%',
            padding: 32,
            width: '100%'
        }
    }, header(upload, siteName), content))
}

function buildFallbackElement(upload: UploadData, siteName: string): OgElement {
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
    buildUploadCountLabel(upload).toUpperCase(),
    element('div', { style: { color: '#a7a7a7', display: 'flex', fontSize: 28 } }, `via ${siteName}`))
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
