import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import {
    MAX_OG_SOURCE_BYTES,
    OG_CARD_WIDTH, OG_CARD_HEIGHT, OG_LEAD_WIDTH, OG_LEAD_HEIGHT,
    truncateFilename,
    buildOgCardElement,
    canNormalizeLeadImage,
    fileTypeColor,
    fileTypeLabel,
    normalizeLeadImage,
    renderOgCard,
    selectLeadImage
} from '../client/src/lib/upload/ogCard.ts'
import sharp from '../client/node_modules/sharp/dist/index.mjs'
import type { FileData, UploadData } from '../client/src/lib/upload/downloader.ts'

function file(index: number, filename: string, mime: string, size = 1000): FileData {
    return {
        index,
        filename,
        size,
        mime,
        url: `https://femboyz.cloud/1234ABCD/${index}`,
        stat_dl: 0
    }
}

function upload(type: UploadData['type'], files: FileData[], title = '', desc = ''): UploadData {
    return {
        id: '1234ABCD',
        type,
        public: false,
        meta: { title, desc },
        views: 0,
        files,
        when: '2026-07-23T00:00:00.000Z'
    }
}

test('labels files by extension with MIME fallbacks and preserves extensions when shortening filenames', () => {
    assert.equal(fileTypeLabel(file(0, 'archive.tar.gz', 'application/gzip')), 'GZ')
    assert.equal(fileTypeLabel(file(0, 'document.тест', 'application/pdf')), 'PDF')
    assert.equal(fileTypeLabel(file(0, 'track', 'audio/mpeg')), 'AUD')
    assert.equal(fileTypeLabel(file(0, 'unknown.longextension', 'application/octet-stream')), 'FILE')
    assert.equal(truncateFilename('short.mp4'), 'short.mp4')
    const long = truncateFilename('a-very-long-video-filename-that-needs-shortening.mp4')
    assert.equal(Array.from(long).length, 23)
    assert.match(long, /….*\.mp4$/u)
    assert.doesNotMatch(truncateFilename('emoji-🔒-track.mp3'), /🔒/u)
})

test('uses the approved category colors', () => {
    assert.equal(fileTypeColor(file(0, 'photo.jpg', 'image/jpeg')), '#6fb3e8')
    assert.equal(fileTypeColor(file(0, 'clip.mp4', 'video/mp4')), '#e0457b')
    assert.equal(fileTypeColor(file(0, 'track.mp3', 'audio/mpeg')), '#5fc7b0')
    assert.equal(fileTypeColor(file(0, 'archive.zip', 'application/zip')), '#e2a74a')
    assert.equal(fileTypeColor(file(0, 'program.exe', 'application/octet-stream')), '#a49ca0')
})

test('selects an image only when it is the first album item and guards normalization inputs', () => {
    const video = file(0, 'clip.mp4', 'video/mp4')
    const webp = file(1, 'photo.webp', 'image/webp')
    const png = file(2, 'photo.png', 'image/png')
    const album = upload('album', [video, webp, png])

    assert.equal(selectLeadImage(album), null)
    assert.equal(selectLeadImage(upload('album', [webp, video])), webp)
    assert.equal(selectLeadImage(upload('files', [png])), null)
    assert.equal(canNormalizeLeadImage(webp), true)
    assert.equal(canNormalizeLeadImage(file(0, 'vector.svg', 'image/svg+xml')), false)
    assert.equal(canNormalizeLeadImage(file(0, 'huge.png', 'image/png', MAX_OG_SOURCE_BYTES + 1)), false)
})

test('normalizes common raster formats to a bounded PNG and rejects malformed input', async () => {
    const fixtures = [
        'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP4r1HxHx9moL0CAJQ/U8GQ6kKRAAAAAElFTkSuQmCC',
        '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAEAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAwf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCWAVc3/9k=',
        'UklGRjQAAABXRUJQVlA4ICgAAABwAQCdASoIAAQAAUAmJaACdAFAAAD+533Zb/8SF//xlT//GVP+H8AA',
        'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAAXBtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAADRpbG9jAAAAAERAAAIAAQAAAAABlAABAAAAAAAAACIAAgAAAAABtgABAAAAAAAAABUAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAAAAABAABhdjAxAAAAABVpbmZlAgAAAAACAABhdjAxAAAAAA5waXRtAAAAAAABAAAAr2lwcnAAAACKaXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAgAAAAEAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQAcAAAAAA5waXhpAAAAAAEIAAAAOGF1eEMAAAAAdXJuOm1wZWc6bXBlZ0I6Y2ljcDpzeXN0ZW1zOmF1eGlsaWFyeTphbHBoYQAAAAAdaXBtYQAAAAAAAAACAAEDgQIDAAIEhAIFhgAAABppcmVmAAAAAAAAAA5hdXhsAAIAAQABAAAAP21kYXQSAAoIOAh+0gIaDSAyFBlCYwTAADQAAJBAyRxdMPIGlVpAEgAKBRgIfsKgMgoYAAABAAIhG6Ng',
        'R0lGODlhCAAEAIAAAExpcf8oeCH5BAUAAAAALAAAAAAIAAQAAAIFjI+piwUAOw=='
    ].map(encoded => Buffer.from(encoded, 'base64'))

    for (const fixture of fixtures) {
        const dataUri = await normalizeLeadImage(fixture)
        assert.ok(dataUri?.startsWith('data:image/png;base64,'))
        const png = Buffer.from(dataUri.slice('data:image/png;base64,'.length), 'base64')
        assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
        assert.equal(png.readUInt32BE(16), OG_LEAD_WIDTH)
        assert.equal(png.readUInt32BE(20), OG_LEAD_HEIGHT)
    }

    assert.equal(await normalizeLeadImage(new Uint8Array([1, 2, 3])), null)
})

test('hides the ID for titled cards and summarizes overflow files without dropping their bytes', () => {
    const files = upload('files', Array.from({ length: 23 }, (_, index) =>
        file(index, `item-${index}.zip`, 'application/zip', 1024)), '🔒 private title')
    const tree = JSON.stringify(buildOgCardElement(files, 'femboyz.cloud', null))
    assert.match(tree, /\? private title/)
    assert.doesNotMatch(tree, /1234ABCD|🔒|item-4\.zip/)
    assert.match(tree, /item-3\.zip/)
    assert.match(tree, /\+19/)
    assert.match(tree, /19\.0 KB/)
    assert.match(tree, /23\.0 KB/)
    assert.doesNotMatch(tree, /23 files ·|—/)
    assert.equal(buildOgCardElement(files, 'femboyz.cloud', null).props.style?.border, undefined)

    const untitled = JSON.stringify(buildOgCardElement(upload('files', []), 'femboyz.cloud', null))
    assert.match(untitled, /1234ABCD/)
    const poster = 'data:image/png;base64,frame'
    const albumTree = JSON.stringify(buildOgCardElement(upload('album', [
        file(0, 'clip.mp4', 'video/mp4'), file(1, 'photo.png', 'image/png')
    ]), 'femboyz.cloud', poster))
    assert.match(albumTree, /data:image\/png;base64,frame/)
})

test('renders the full card as a wide PNG without network requests or falling back to text', async () => {
    const files = upload('files', [
        file(0, 'archive.zip', 'application/zip'),
        file(1, 'manual.pdf', 'application/pdf')
    ], '🔒 private title')
    const originalFetch = globalThis.fetch
    let fetchCount = 0
    globalThis.fetch = (async () => {
        fetchCount++
        throw new Error('Unexpected remote fetch')
    }) as typeof fetch
    try {
        const png = Buffer.from(await renderOgCard(files, 'femboyz.cloud', null, [
            { name: 'DejaVu Sans', weight: 400, data: await readFile(new URL('../client/src/lib/server/upload/assets/DejaVuSans.ttf', import.meta.url)) },
            { name: 'DejaVu Sans', weight: 700, data: await readFile(new URL('../client/src/lib/server/upload/assets/DejaVuSans-Bold.ttf', import.meta.url)) }
        ]))
        assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
        assert.equal(png.readUInt32BE(16), OG_CARD_WIDTH)
        assert.equal(png.readUInt32BE(20), OG_CARD_HEIGHT)
        const panelPixel = await sharp(png).extract({ left: 480, top: 64, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
        assert.deepEqual([...panelPixel], [35, 32, 33], 'the file panel must render instead of the text fallback')
        assert.equal(fetchCount, 0)
    } finally {
        globalThis.fetch = originalFetch
    }
})
