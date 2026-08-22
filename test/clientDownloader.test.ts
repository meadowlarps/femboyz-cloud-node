import assert from 'node:assert/strict'
import test from 'node:test'
import { markUploadViewed } from '../client/src/lib/upload/downloader.ts'

test('marks an upload viewed with the dedicated POST endpoint', async () => {
    let requestedUrl = ''
    let requestedMethod = ''
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
        requestedUrl = String(input)
        requestedMethod = init?.method ?? 'GET'
        return new Response(null, { status: 204 })
    }) as typeof fetch

    await markUploadViewed('123XABCD', 'https://api.example.com/', fetcher)

    assert.equal(requestedUrl, 'https://api.example.com/api/v2/viewed/123XABCD')
    assert.equal(requestedMethod, 'POST')
})

test('rejects when the view request fails', async () => {
    const fetcher = (async () => new Response(null, { status: 404 })) as typeof fetch

    await assert.rejects(
        markUploadViewed('missing', '', fetcher),
        { message: '404' }
    )
})
