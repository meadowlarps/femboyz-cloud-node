import assert from 'node:assert/strict'
import test from 'node:test'
import {
    MAX_OG_SOURCE_BYTES,
    buildOgCardElement,
    buildTileLabels,
    canNormalizeLeadImage,
    fileTypeLabel,
    mediaTypeLabel,
    normalizeLeadImage,
    renderOgCard,
    selectLeadImage
} from '../client/src/lib/upload/ogCard.ts'
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

function upload(type: UploadData['type'], files: FileData[], title = ''): UploadData {
    return {
        id: '1234ABCD',
        type,
        public: false,
        meta: { title, desc: '' },
        views: 0,
        files,
        when: '2026-07-23T00:00:00.000Z'
    }
}

test('builds safe file labels and preserves the first six item order', () => {
    assert.equal(fileTypeLabel(file(0, 'archive.tar.gz', 'application/gzip')), 'GZ')
    assert.equal(fileTypeLabel(file(0, 'document.тест', 'application/pdf')), 'PDF')
    assert.equal(fileTypeLabel(file(0, 'track', 'audio/mpeg')), 'AUD')
    assert.equal(fileTypeLabel(file(0, 'animation', 'image/gif')), 'GIF')
    assert.equal(fileTypeLabel(file(0, 'unknown.longextension', 'application/octet-stream')), 'FILE')
    assert.equal(mediaTypeLabel(file(0, 'clip.mp4', 'video/mp4')), 'VID')
    assert.equal(mediaTypeLabel(file(0, 'still.png', 'image/png')), 'IMG')
    assert.equal(mediaTypeLabel(file(0, 'animation.gif', 'image/gif')), 'GIF')

    const files = Array.from({ length: 8 }, (_, index) => file(index, `item.${index}`, 'application/octet-stream'))
    assert.deepEqual(buildTileLabels(files), ['0', '1', '2', '3', '4', '5'])
    assert.deepEqual(buildTileLabels(files, 2), ['0', '1', '3', '4', '5', '6'])
})

test('selects only the first album image and guards normalization inputs', () => {
    const video = file(0, 'clip.mp4', 'video/mp4')
    const webp = file(1, 'photo.webp', 'image/webp')
    const png = file(2, 'photo.png', 'image/png')
    const album = upload('album', [video, webp, png])

    assert.equal(selectLeadImage(album), webp)
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
        assert.equal(png.readUInt32BE(16), 760)
        assert.equal(png.readUInt32BE(20), 360)
    }

    assert.equal(await normalizeLeadImage(new Uint8Array([1, 2, 3])), null)
})

test('renders a 1200x630 PNG without fetching remote assets or exposing custom text', async () => {
    const files = upload('files', [
        file(0, 'archive.zip', 'application/zip'),
        file(1, 'manual.pdf', 'application/pdf')
    ], '🔒 private title')
    assert.doesNotMatch(JSON.stringify(buildOgCardElement(files, 'femboyz.cloud', null)), /private title/)

    const originalFetch = globalThis.fetch
    let fetchCount = 0
    globalThis.fetch = (async () => {
        fetchCount++
        throw new Error('Unexpected remote fetch')
    }) as typeof fetch

    try {
        const png = Buffer.from(await renderOgCard(files, 'femboyz.cloud', null))
        assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
        assert.equal(png.readUInt32BE(16), 1200)
        assert.equal(png.readUInt32BE(20), 630)
        assert.equal(fetchCount, 0)
    } finally {
        globalThis.fetch = originalFetch
    }
})
