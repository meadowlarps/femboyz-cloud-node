import assert from 'node:assert/strict'
import test from 'node:test'
import {
    OG_CARD_VERSION,
    buildUploadCountLabel,
    buildUploadPreview,
    hasGeneratedCard,
    isPreviewCrawler
} from '../client/src/lib/upload/preview.ts'
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

test('redirects preview crawlers only for raw single media', () => {
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
    assert.equal(buildUploadPreview(upload('playlist', [file(0, 'audio/mpeg')]), 'https://femboyz.cloud', 'TelegramBot').redirectUrl, null)
})

test('uses the custom title or upload ID and only a custom description', () => {
    const custom = buildUploadPreview(
        upload('album', [file(0, 'image/png'), file(1, 'video/mp4')], '  My upload  ', '  My description  '),
        'https://femboyz.cloud',
        null
    )
    assert.equal(custom.title, 'My upload')
    assert.equal(custom.description, 'My description')
    assert.equal(custom.siteName, 'femboyz.cloud')
    assert.equal(custom.canonicalUrl, 'https://femboyz.cloud/1234ABCD')

    assert.equal(buildUploadPreview(upload('files', [file(0, 'application/zip')]), 'https://femboyz.cloud', null).title, '1234ABCD')
    assert.equal(buildUploadPreview(upload('playlist', [file(0, 'audio/mpeg')]), 'https://femboyz.cloud', null).title, '1234ABCD')
    assert.equal(buildUploadPreview(upload('album', [file(0, 'image/png')]), 'https://femboyz.cloud', null).title, '1234ABCD')
    assert.equal(buildUploadPreview(upload('files', [file(0, 'text/plain')]), 'https://femboyz.cloud', null).description, '')
    assert.equal(buildUploadPreview(upload('files', [file(0, 'text/plain')], 'Notes'), 'https://femboyz.cloud', null).description, '')
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

test('generates versioned cards for files, playlists, and multi-media albums', () => {
    const files = upload('files', [file(0, 'application/pdf')])
    const playlist = upload('playlist', [file(0, 'audio/mpeg')])
    const album = upload('album', [file(0, 'image/png'), file(1, 'video/mp4')])
    const singleMedia = upload('album', [file(0, 'image/png')])
    const link = upload('link', [])

    assert.equal(hasGeneratedCard(files), true)
    assert.equal(hasGeneratedCard(playlist), true)
    assert.equal(hasGeneratedCard(album), true)
    assert.equal(hasGeneratedCard(singleMedia), false)
    assert.equal(hasGeneratedCard(link), false)

    const preview = buildUploadPreview(files, 'https://femboyz.cloud', null)
    assert.equal(OG_CARD_VERSION, '7')
    assert.equal(preview.cardImageUrl, `https://femboyz.cloud/1234ABCD/og.png?v=${OG_CARD_VERSION}`)
    assert.equal(preview.cardImageAlt, '1234ABCD: 1 file via femboyz.cloud')
    assert.equal(buildUploadPreview(singleMedia, 'https://femboyz.cloud', null).cardImageUrl, null)
})

test('exports the same type-aware count labels used by metadata and generated cards', () => {
    assert.equal(buildUploadCountLabel(upload('files', [file(0, 'text/plain')])), '1 file')
    assert.equal(buildUploadCountLabel(upload('playlist', [file(0, 'audio/ogg'), file(1, 'audio/mpeg')])), '2 tracks')
    assert.equal(buildUploadCountLabel(upload('album', [file(0, 'video/mp4'), file(1, 'image/png')])), '2 media')
})
