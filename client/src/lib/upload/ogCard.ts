import { ImageResponse } from '@vercel/og'
import type { ImageResponseOptions } from '@vercel/og'
import sharp from 'sharp'
import type { FileData, UploadData } from './downloader.js'
import {
    FILE_KINDS, OG_CARD_WIDTH, OG_CARD_HEIGHT, buildUploadCountLabel,
    fileKind, fileKindCountLabel, formatPreviewSize, summarizeUploadFiles
} from './preview.js'
import { OG_LOGO } from './ogLogo.js'

export { OG_CARD_WIDTH, OG_CARD_HEIGHT } from './preview.js'

export const OG_LEAD_WIDTH = 678
export const OG_LEAD_HEIGHT = 526
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

export function fileTypeColor(file: FileData): string {
    return FILE_KINDS[fileKind(file)].color
}

function safeCardText(value: string, maxLength: number): string {
    const clean = value
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .replace(/[^\u0020-\u017f\u0400-\u045f]/gu, '?')
        .trim()
    const chars = Array.from(clean)
    return chars.length <= maxLength ? clean : `${chars.slice(0, maxLength - 1).join('')}…`
}

export function truncateFilename(filename: string, maxLength = 23): string {
    const chars = Array.from(safeCardText(filename, 1000))
    if (chars.length <= maxLength) return chars.join('')
    const extension = chars.join('').match(/\.[^.]{1,5}$/u)?.[0] ?? ''
    const tailLength = Math.min(maxLength - 2, extension ? Array.from(extension).length + 4 : 8)
    return `${chars.slice(0, maxLength - tailLength - 1).join('')}…${chars.slice(-tailLength).join('')}`
}

function text(value: string, style: Style = {}): OgElement {
    return element('div', { style: { display: 'flex', ...style } }, value)
}

function fileRow(file: FileData | null, count: number, bytes: number, last: boolean): OgElement {
    const color = file ? fileTypeColor(file) : '#6a6468'
    return element('div', {
        style: {
            alignItems: 'center', borderBottom: last ? '0px' : '2px solid #2e2b2c',
            display: 'flex', gap: 22, height: 102, flexShrink: 0
        }
    },
    text(file ? fileTypeLabel(file) : `+${count}`, {
        alignItems: 'center', border: `2px ${file ? 'solid' : 'dashed'} ${color}`, color,
        fontSize: 18, fontWeight: 700, height: 40, justifyContent: 'center', width: 76, flexShrink: 0
    }),
    text(file ? truncateFilename(file.filename) : 'more files', {
        color: file ? '#f4f4f4' : '#8a8385', flex: 1, minWidth: 0, fontSize: 25,
        fontWeight: file ? 600 : 400, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis'
    }),
    text(formatPreviewSize(bytes), { color: '#8a8385', fontSize: 23, flexShrink: 0 }))
}

function fileList(upload: UploadData): OgElement {
    const shown = upload.files.slice(0, upload.files.length > 5 ? 4 : 5)
    const remaining = upload.files.slice(shown.length)
    return element('div', {
        style: {
            background: '#232021', border: '2px solid #3b3538', display: 'flex',
            flexDirection: 'column', height: OG_LEAD_HEIGHT, padding: '6px 30px', width: OG_LEAD_WIDTH
        }
    },
    ...shown.map((file, index) => fileRow(file, 1, file.size, index === shown.length - 1 && remaining.length === 0)),
    ...(remaining.length > 0 ? [fileRow(null, remaining.length,
        remaining.reduce((total, file) => total + file.size, 0), true)] : []))
}

function statistics(upload: UploadData): OgElement {
    const summary = summarizeUploadFiles(upload.files)
    const groups = summary.groups.toSorted((a, b) => b.bytes - a.bytes)
    // Reserve a visible sliver for each kind while keeping the bar within its 330px width.
    const availableWidth = 330 - Math.max(0, groups.length - 1) * 3 - groups.length * 6
    return element('div', { style: { display: 'flex', flexDirection: 'column' } },
        element('div', { style: { alignItems: 'baseline', display: 'flex', gap: 18, marginTop: 14, fontSize: 26 } },
            text(buildUploadCountLabel(upload), { color: '#c9c3c5', fontWeight: 600 }),
            text(formatPreviewSize(summary.bytes), { color: '#8a8385' })),
        element('div', { style: { display: 'flex', gap: 3, height: 10, marginTop: 26, width: 330 } },
            ...groups.map(group => element('div', {
                style: {
                    background: FILE_KINDS[group.kind].color, height: 10,
                    width: 6 + (summary.bytes > 0 ? group.bytes / summary.bytes : 1 / groups.length) * availableWidth
                }
            }))),
        element('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 18, marginTop: 12, width: 340 } },
            ...(groups.length > 1 ? groups.map(group => element('div', {
                style: { alignItems: 'center', display: 'flex', gap: 7, fontSize: 19, color: '#8a8385' }
            },
            element('div', { style: { background: FILE_KINDS[group.kind].color, width: 10, height: 10 } }),
            fileKindCountLabel(group.kind, group.count))) : [])))
}

export function buildOgCardElement(upload: UploadData, _siteName: string, leadMediaDataUri: string | null): OgElement {
    const customTitle = upload.meta.title.trim()
    const headline = element('div', { style: { display: 'flex', flexDirection: 'column' } },
        ...(!customTitle ? [text(upload.type === 'playlist' ? 'PLAYLIST' : upload.type === 'album' ? 'ALBUM' : 'FILES', {
            color: '#c30f45', fontSize: 22, fontWeight: 700, letterSpacing: 3
        })] : []),
        text(safeCardText(customTitle || upload.id, 140), {
            color: '#f4f4f4', fontSize: customTitle ? 54 : 62, fontWeight: 800, lineHeight: 1.02,
            letterSpacing: -0.6, marginTop: 10, display: 'block', lineClamp: 2, overflow: 'hidden',
            textOverflow: 'ellipsis', ...(customTitle ? {} : { whiteSpace: 'nowrap' })
        }),
        statistics(upload))

    const content = upload.type === 'album' && leadMediaDataUri
        ? element('img', {
            src: leadMediaDataUri, width: OG_LEAD_WIDTH, height: OG_LEAD_HEIGHT,
            style: { height: OG_LEAD_HEIGHT, width: OG_LEAD_WIDTH, objectFit: 'cover', border: '2px solid #3b3538' }
        })
        : fileList(upload)

    return element('div', {
        style: { background: '#1b1a1a', color: '#f4f4f4', fontFamily: 'DejaVu Sans', display: 'flex', width: '100%', height: '100%' }
    },
    element('div', {
        style: {
            display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
            padding: '52px 0px 52px 60px', width: 450, flexShrink: 0
        }
    },
    element('img', { src: OG_LOGO, width: 192, height: 196, style: { width: 192, height: 196 } }),
    headline),
    element('div', { style: { display: 'flex', margin: '52px 52px 52px 20px' } }, content))
}

function buildFallbackElement(upload: UploadData, siteName: string): OgElement {
    return element('div', {
        style: {
            alignItems: 'center', background: '#1b1a1a', color: '#f4f4f4', display: 'flex',
            flexDirection: 'column', fontSize: 52, gap: 18, height: '100%',
            justifyContent: 'center', padding: 60, width: '100%'
        }
    },
    text(safeCardText(upload.meta.title.trim() || upload.id, 70)),
    text(`${buildUploadCountLabel(upload)} via ${safeCardText(siteName, 100)}`, { color: '#8a8385', fontSize: 28 }))
}

async function render(elementTree: OgElement, fonts: ImageResponseOptions['fonts']): Promise<ArrayBuffer> {
    // @vercel/og accepts React-shaped objects at runtime; React itself is not required.
    const response = new ImageResponse(elementTree as never, {
        width: OG_CARD_WIDTH,
        height: OG_CARD_HEIGHT,
        ...(fonts ? { fonts } : {})
    })
    return response.arrayBuffer()
}

export async function renderOgCard(
    upload: UploadData,
    siteName: string,
    leadMediaDataUri: string | null,
    fonts?: ImageResponseOptions['fonts']
): Promise<ArrayBuffer> {
    try {
        return await render(buildOgCardElement(upload, siteName, leadMediaDataUri), fonts)
    } catch {
        return render(buildFallbackElement(upload, siteName), fonts)
    }
}
