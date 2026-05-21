import type { XMetaFiles } from "./schema.js"

export async function receiveUpload(_meta: XMetaFiles, _files: Buffer[]): Promise<void> {
    // TODO: check STORAGE_LIMIT_BYTES before writing
    // TODO: write each buffer to STORAGE_DIR/<sha256>
    // TODO: save metadata + file references to MongoDB
}
