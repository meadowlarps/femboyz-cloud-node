import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'
import { OG_LEAD_HEIGHT, OG_LEAD_WIDTH } from '../../upload/ogCard'

const MAX_FRAME_BYTES = 8 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export async function extractVideoFrame(source: string): Promise<string | null> {
    const binary = ffmpegPath
    if (!binary) return null

    return new Promise(resolve => {
        const child = spawn(binary, [
            '-hide_banner',
            '-loglevel', 'error',
            '-nostdin',
            '-i', source,
            '-map', '0:v:0',
            '-frames:v', '1',
            '-an',
            '-sn',
            '-dn',
            '-vf', `scale=${OG_LEAD_WIDTH}:${OG_LEAD_HEIGHT}:force_original_aspect_ratio=increase,crop=${OG_LEAD_WIDTH}:${OG_LEAD_HEIGHT}`,
            '-f', 'image2pipe',
            '-c:v', 'png',
            'pipe:1'
        ], { windowsHide: true })
        child.stderr.resume()
        const chunks: Buffer[] = []
        let bytes = 0
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined

        const finish = (frame: Buffer | null) => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            resolve(frame ? `data:image/png;base64,${frame.toString('base64')}` : null)
        }

        timer = setTimeout(() => {
            child.kill('SIGKILL')
            finish(null)
        }, 15_000)

        child.stdout.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > MAX_FRAME_BYTES) {
                child.kill('SIGKILL')
                finish(null)
                return
            }
            chunks.push(chunk)
        })
        child.on('error', () => finish(null))
        child.on('close', code => {
            const frame = code === 0 ? Buffer.concat(chunks) : null
            finish(frame?.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? frame : null)
        })
    })
}
