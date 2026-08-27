import assert from 'node:assert/strict'
import test from 'node:test'
import {
    CLIENT_UUID_STORAGE_KEY,
    COMMENT_REACTIONS_STORAGE_KEY,
    createUploadComment,
    extractApiError,
    fetchUploadComments,
    getOrCreateClientUuid,
    joinApiPath,
    readCommentReactions,
    updateCommentReaction,
    writeCommentReaction,
    type CommentPublic,
    type StorageLike
} from '../client/src/lib/upload/comments.ts'

const SAMPLE_UUID = '550e8400-e29b-4168-a716-446655440000'
const SAMPLE_COMMENT: CommentPublic = {
    id: '12345678',
    content: 'hello',
    when: '2026-08-27T10:00:00.000Z',
    stat: { up: 1, down: 0, eyes: 2 }
}

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
    const data = new Map(Object.entries(initial))
    return {
        getItem(key) {
            return data.has(key) ? data.get(key)! : null
        },
        setItem(key, value) {
            data.set(key, value)
        },
        removeItem(key) {
            data.delete(key)
        }
    }
}

test('joinApiPath normalizes trailing slashes', () => {
    assert.equal(joinApiPath('https://api.example.com/', '/api/v2/feed'), 'https://api.example.com/api/v2/feed')
    assert.equal(joinApiPath('https://api.example.com', 'api/v2/feed'), 'https://api.example.com/api/v2/feed')
})

test('extractApiError prefers JSON error messages', async () => {
    const response = new Response(JSON.stringify({ error: 'Upload not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
    })
    assert.equal(await extractApiError(response), 'Upload not found')
})

test('extractApiError falls back to status code', async () => {
    const response = new Response('nope', { status: 500 })
    assert.equal(await extractApiError(response), '500')
})

test('fetchUploadComments requests the upload comments endpoint', async () => {
    let requestedUrl = ''
    let requestedHeaders: Record<string, string> = {}
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
        requestedUrl = String(input)
        requestedHeaders = Object.fromEntries(new Headers(init?.headers).entries())
        return Response.json([SAMPLE_COMMENT])
    }) as typeof fetch

    const comments = await fetchUploadComments('123XABCD', 'https://api.example.com/', fetcher, {
        'x-forwarded-for': '203.0.113.1'
    })

    assert.equal(requestedUrl, 'https://api.example.com/api/v2/uploads/123XABCD/comments')
    assert.equal(requestedHeaders.accept, 'application/json')
    assert.equal(requestedHeaders['x-forwarded-for'], '203.0.113.1')
    assert.deepEqual(comments, [SAMPLE_COMMENT])
})

test('createUploadComment sends body, UUID header, and requires 201', async () => {
    let requestedUrl = ''
    let requestedMethod = ''
    let requestedHeaders: Record<string, string> = {}
    let requestedBody = ''
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
        requestedUrl = String(input)
        requestedMethod = init?.method ?? 'GET'
        requestedHeaders = Object.fromEntries(new Headers(init?.headers).entries())
        requestedBody = String(init?.body ?? '')
        return Response.json(SAMPLE_COMMENT, { status: 201 })
    }) as typeof fetch

    const created = await createUploadComment(
        '123XABCD',
        'https://api.example.com',
        { content: 'hello', id_reply_to: '87654321' },
        SAMPLE_UUID,
        fetcher
    )

    assert.equal(requestedUrl, 'https://api.example.com/api/v2/uploads/123XABCD/comments')
    assert.equal(requestedMethod, 'POST')
    assert.equal(requestedHeaders['content-type'], 'application/json')
    assert.equal(requestedHeaders['x-client-uuid'], SAMPLE_UUID)
    assert.deepEqual(JSON.parse(requestedBody), { content: 'hello', id_reply_to: '87654321' })
    assert.deepEqual(created, SAMPLE_COMMENT)
})

test('updateCommentReaction sends full desired state', async () => {
    let requestedUrl = ''
    let requestedMethod = ''
    let requestedBody = ''
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
        requestedUrl = String(input)
        requestedMethod = init?.method ?? 'GET'
        requestedBody = String(init?.body ?? '')
        return Response.json({
            ...SAMPLE_COMMENT,
            stat: { up: 2, down: 0, eyes: 2 }
        })
    }) as typeof fetch

    const updated = await updateCommentReaction(
        '12345678',
        'https://api.example.com/',
        { rating: 'up', eyes: true },
        SAMPLE_UUID,
        fetcher
    )

    assert.equal(requestedUrl, 'https://api.example.com/api/v2/comments/12345678/reactions')
    assert.equal(requestedMethod, 'PUT')
    assert.deepEqual(JSON.parse(requestedBody), { rating: 'up', eyes: true })
    assert.deepEqual(updated.stat, { up: 2, down: 0, eyes: 2 })
})

test('API helpers surface API failures', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ error: 'Invalid comment' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
    })) as typeof fetch

    await assert.rejects(
        createUploadComment('123XABCD', '', { content: 'x' }, SAMPLE_UUID, fetcher),
        { message: 'Invalid comment' }
    )
})

test('getOrCreateClientUuid persists a valid UUID', () => {
    const storage = memoryStorage()
    const first = getOrCreateClientUuid(storage, () => SAMPLE_UUID)
    const second = getOrCreateClientUuid(storage, () => '11111111-1111-4111-8111-111111111111')

    assert.equal(first, SAMPLE_UUID)
    assert.equal(second, SAMPLE_UUID)
    assert.equal(storage.getItem(CLIENT_UUID_STORAGE_KEY), SAMPLE_UUID)
})

test('getOrCreateClientUuid replaces malformed stored UUIDs', () => {
    const storage = memoryStorage({ [CLIENT_UUID_STORAGE_KEY]: 'not-a-uuid' })
    const created = getOrCreateClientUuid(storage, () => SAMPLE_UUID)

    assert.equal(created, SAMPLE_UUID)
    assert.equal(storage.getItem(CLIENT_UUID_STORAGE_KEY), SAMPLE_UUID)
})

test('readCommentReactions recovers from malformed storage', () => {
    const storage = memoryStorage({ [COMMENT_REACTIONS_STORAGE_KEY]: '{not json' })
    assert.deepEqual(readCommentReactions(storage), {})
    assert.equal(storage.getItem(COMMENT_REACTIONS_STORAGE_KEY), null)
})

test('writeCommentReaction persists validated reaction state', () => {
    const storage = memoryStorage()
    writeCommentReaction('12345678', { rating: 'down', eyes: false }, storage)

    assert.deepEqual(readCommentReactions(storage), {
        '12345678': { rating: 'down', eyes: false }
    })
})
