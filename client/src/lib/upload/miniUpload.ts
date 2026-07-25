import type { UploadData } from './downloader.js'

export function buildMiniUploadTypeLabel(upload: UploadData): string {
    if (upload.files.length > 1) {
        return upload.type === 'album' ? 'ALBUM' : upload.type === 'playlist' ? 'PLAYLIST' : 'FILES'
    }

    if (upload.type === 'album') {
        return upload.files[0]?.mime.startsWith('image/gif')
            ? 'GIF'
            : upload.files[0]?.mime.startsWith('image/') ? 'IMAGE' : 'VIDEO'
    }

    return upload.type === 'playlist' ? 'AUDIO' : 'FILE'
}
