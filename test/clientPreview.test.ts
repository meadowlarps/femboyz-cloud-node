import assert from 'node:assert/strict'
import test from 'node:test'
import { buildUploadPreview, isPreviewCrawler } from '../client/src/lib/upload/preview.ts'
import type { FileData, UploadData } from '../client/src/lib/upload/downloader.ts'

function file(index: number, mime: string): FileData {
    return {
        index,
        filename: `file-${index}`,
        size: 1000,
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

test('recognizes only Discord and Telegram preview crawlers', () => {
    assert.equal(isPreviewCrawler('Mozilla/5.0 (compatible; Discordbot/2.0)'), true)
    assert.equal(isPreviewCrawler('TelegramBot (like TwitterBot)'), true)
    assert.equal(isPreviewCrawler('Mozilla/5.0'), false)
    assert.equal(isPreviewCrawler(null), false)
})

test('redirects preview crawlers only for a single album media file', () => {
    const image = file(0, 'image/png')
    const video = file(0, 'video/mp4')
    const gif = file(0, 'image/gif')
    const crawler = 'Discordbot/2.0'

    assert.equal(buildUploadPreview(upload('album', [image]), 'https://femboyz.cloud', crawler).redirectUrl, image.url)
    assert.equal(buildUploadPreview(upload('album', [video]), 'https://femboyz.cloud', crawler).redirectUrl, video.url)
    assert.equal(buildUploadPreview(upload('album', [gif]), 'https://femboyz.cloud', crawler).redirectUrl, gif.url)
    assert.equal(buildUploadPreview(upload('album', [image]), 'https://femboyz.cloud', 'Mozilla/5.0').redirectUrl, null)
    assert.equal(buildUploadPreview(upload('album', [image, video]), 'https://femboyz.cloud', crawler).redirectUrl, null)
    assert.equal(buildUploadPreview(upload('files', [file(0, 'application/pdf')]), 'https://femboyz.cloud', crawler).redirectUrl, null)
    assert.equal(buildUploadPreview(upload('playlist', [file(0, 'audio/mpeg')]), 'https://femboyz.cloud', crawler).redirectUrl, null)
})

test('prefers user text and generates type-aware fallbacks', () => {
    const custom = buildUploadPreview(
        upload('album', [file(0, 'image/png'), file(1, 'video/mp4')], '  My upload  ', '  My description  '),
        'https://femboyz.cloud',
        null
    )
    assert.equal(custom.title, 'My upload')
    assert.equal(custom.description, 'My description')
    assert.equal(custom.siteName, 'femboyz.cloud')
    assert.equal(custom.canonicalUrl, 'https://femboyz.cloud/1234ABCD')

    assert.equal(buildUploadPreview(upload('files', [file(0, 'application/zip')]), 'https://femboyz.cloud', null).title, '1 file')
    assert.equal(buildUploadPreview(upload('files', [file(0, 'application/zip'), file(1, 'text/plain')]), 'https://femboyz.cloud', null).title, '2 files')
    assert.equal(buildUploadPreview(upload('playlist', [file(0, 'audio/mpeg')]), 'https://femboyz.cloud', null).title, '1 track')
    assert.equal(buildUploadPreview(upload('playlist', [file(0, 'audio/mpeg'), file(1, 'audio/ogg')]), 'https://femboyz.cloud', null).title, '2 tracks')
    assert.equal(buildUploadPreview(upload('album', [file(0, 'image/png')]), 'https://femboyz.cloud', null).title, '1 media item')
    assert.equal(buildUploadPreview(upload('album', [file(0, 'image/png'), file(1, 'video/mp4')]), 'https://femboyz.cloud', null).title, '2 media')
    assert.equal(buildUploadPreview(upload('files', [file(0, 'text/plain')]), 'https://femboyz.cloud', null).description, 'via femboyz.cloud')
    assert.equal(buildUploadPreview(upload('files', [file(0, 'text/plain')], 'Notes'), 'https://femboyz.cloud', null).description, '1 file via femboyz.cloud')
})

test('uses the first image, then falls back to the first video', () => {
    const firstVideo = file(0, 'video/mp4')
    const image = file(1, 'image/webp')
    const secondVideo = file(2, 'video/webm')
    const mixed = buildUploadPreview(upload('album', [firstVideo, image]), 'https://femboyz.cloud', null)
    const videos = buildUploadPreview(upload('album', [firstVideo, secondVideo]), 'https://femboyz.cloud', null)

    assert.equal(mixed.image?.url, image.url)
    assert.equal(mixed.video, null)
    assert.equal(videos.image, null)
    assert.equal(videos.video?.url, firstVideo.url)
})
