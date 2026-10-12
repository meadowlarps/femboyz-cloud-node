import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchUploads, markUploadViewed } from '../client/src/lib/upload/downloader.ts'

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

test('fetches several uploads with one batch request', async () => {
    const requestedUrls: string[] = []
    const fetcher = (async (input: URL | RequestInfo) => {
        requestedUrls.push(String(input))
        return Response.json({ items: [{ id: '123XABCD' }], missing: ['456YEFGH'] })
    }) as typeof fetch

    const batch = await fetchUploads(['123XABCD', '456YEFGH'], 'https://api.example.com/', fetcher)

    assert.deepEqual(requestedUrls, ['https://api.example.com/api/v2/uploads?ids=123XABCD,456YEFGH'])
    assert.deepEqual(batch.items.map((item) => item.id), ['123XABCD'])
    assert.deepEqual(batch.missing, ['456YEFGH'])
})

test('splits batches larger than the server cap into chunks of 100', async () => {
    const chunkSizes: number[] = []
    const fetcher = (async (input: URL | RequestInfo) => {
        chunkSizes.push(new URL(String(input)).searchParams.get('ids')!.split(',').length)
        return Response.json({ items: [], missing: [] })
    }) as typeof fetch

    const ids = Array.from({ length: 250 }, (_, index) => `ID${index}`)
    await fetchUploads(ids, 'https://api.example.com', fetcher)

    assert.deepEqual(chunkSizes, [100, 100, 50])
})

test('rejects when the batch request fails', async () => {
    const fetcher = (async () => new Response(null, { status: 400 })) as typeof fetch

    await assert.rejects(fetchUploads(['x'], '', fetcher), { message: '400' })
})
