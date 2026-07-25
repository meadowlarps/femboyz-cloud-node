import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMiniUploadTypeLabel } from '../client/src/lib/upload/miniUpload.ts'
import type { FileData, UploadData } from '../client/src/lib/upload/downloader.ts'

function upload(type: UploadData['type'], ...mimes: string[]): UploadData {
    const files: FileData[] = mimes.map((mime, index) => ({
        index,
        filename: `file-${index}`,
        size: 1,
        mime,
        url: `/${index}`,
        stat_dl: 0
    }))

    return {
        id: '1234ABCD',
        type,
        public: false,
        meta: { title: '', desc: '' },
        views: 0,
        files,
        when: '2026-07-25T00:00:00.000Z'
    }
}

test('labels mini uploads by file count and media type', () => {
    assert.equal(buildMiniUploadTypeLabel(upload('album', 'video/mp4')), 'VIDEO')
    assert.equal(buildMiniUploadTypeLabel(upload('album', 'image/png')), 'IMAGE')
    assert.equal(buildMiniUploadTypeLabel(upload('album', 'image/gif')), 'GIF')
    assert.equal(buildMiniUploadTypeLabel(upload('album', 'image/png', 'video/mp4')), 'ALBUM')
    assert.equal(buildMiniUploadTypeLabel(upload('playlist', 'audio/mpeg')), 'AUDIO')
    assert.equal(buildMiniUploadTypeLabel(upload('playlist', 'audio/mpeg', 'audio/ogg')), 'PLAYLIST')
    assert.equal(buildMiniUploadTypeLabel(upload('files', 'application/pdf')), 'FILE')
    assert.equal(buildMiniUploadTypeLabel(upload('files', 'application/pdf', 'text/plain')), 'FILES')
})
