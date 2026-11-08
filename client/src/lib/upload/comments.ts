import { ApiError, apiErrorFromResponse, apiFetch, BAD_RESPONSE } from '../apiError.js'

export type CommentStat = {
    up: number
    down: number
    eyes: number
}

export type CommentPublic = {
    id: string
    id_reply_to?: string
    content: string
    when: string
    stat: CommentStat
}

export type CommentReactionState = {
    rating: 'up' | 'down' | null
    eyes: boolean
}

export type CommentCreateBody = {
    content: string
    id_reply_to?: string
}

export type StorageLike = {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
}

export type UuidGenerator = () => string

export const CLIENT_UUID_STORAGE_KEY = 'fbc_client_uuid'
export const COMMENT_REACTIONS_STORAGE_KEY = 'fbc_comment_reactions'

const CLIENT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const COMMENT_ID_PATTERN = /^\d{8}$/

export function joinApiPath(apiEndpoint: string, path: string): string {
    const base = apiEndpoint.replace(/\/$/, '')
    const suffix = path.startsWith('/') ? path : `/${path}`
    return `${base}${suffix}`
}

export function isClientUuid(value: string): boolean {
    return CLIENT_UUID_PATTERN.test(value)
}

export function isCommentId(value: string): boolean {
    return COMMENT_ID_PATTERN.test(value)
}

function isReactionState(value: unknown): value is CommentReactionState {
    if (!value || typeof value !== 'object') return false
    const record = value as Record<string, unknown>
    return (record.rating === null || record.rating === 'up' || record.rating === 'down')
        && typeof record.eyes === 'boolean'
}

function isCommentPublic(value: unknown): value is CommentPublic {
    if (!value || typeof value !== 'object') return false
    const record = value as Record<string, unknown>
    if (typeof record.id !== 'string' || !isCommentId(record.id)) return false
    if (typeof record.content !== 'string' || typeof record.when !== 'string') return false
    if (record.id_reply_to !== undefined && (typeof record.id_reply_to !== 'string' || !isCommentId(record.id_reply_to)))
        return false
    if (!record.stat || typeof record.stat !== 'object') return false
    const stat = record.stat as Record<string, unknown>
    return typeof stat.up === 'number'
        && typeof stat.down === 'number'
        && typeof stat.eyes === 'number'
}

/** The readable error a failed response carries, or a sentence for its status. */
export async function extractApiError(response: Response): Promise<string> {
    return (await apiErrorFromResponse(response)).message
}

async function readApiJson<T>(
    response: Response,
    validate: (value: unknown) => value is T
): Promise<T> {
    if (!response.ok)
        throw await apiErrorFromResponse(response)

    const body = await response.json().catch(() => null) as unknown
    if (!validate(body))
        throw new ApiError(response.status, BAD_RESPONSE)

    return body
}

export function getOrCreateClientUuid(
    storage?: StorageLike,
    uuidGen: UuidGenerator = () => crypto.randomUUID()
): string {
    const store = storage ?? defaultStorage()
    const existing = store.getItem(CLIENT_UUID_STORAGE_KEY)
    if (existing && isClientUuid(existing)) return existing

    const created = uuidGen()
    if (!isClientUuid(created))
        throw new Error("Comments unavailable. Reload the page.")

    store.setItem(CLIENT_UUID_STORAGE_KEY, created)
    return created
}

export function readCommentReactions(storage?: StorageLike): Record<string, CommentReactionState> {
    const store = storage ?? defaultStorage()
    const raw = store.getItem(COMMENT_REACTIONS_STORAGE_KEY)
    if (!raw) return {}

    try {
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            store.removeItem(COMMENT_REACTIONS_STORAGE_KEY)
            return {}
        }

        const result: Record<string, CommentReactionState> = {}
        for (const [commentId, value] of Object.entries(parsed)) {
            if (!isCommentId(commentId) || !isReactionState(value)) {
                store.removeItem(COMMENT_REACTIONS_STORAGE_KEY)
                return {}
            }
            result[commentId] = value
        }
        return result
    } catch {
        store.removeItem(COMMENT_REACTIONS_STORAGE_KEY)
        return {}
    }
}

export function writeCommentReaction(
    commentId: string,
    state: CommentReactionState,
    storage?: StorageLike
): void {
    if (!isCommentId(commentId) || !isReactionState(state))
        throw new Error("Couldn't save reaction.")

    const store = storage ?? defaultStorage()
    const reactions = readCommentReactions(store)
    reactions[commentId] = state
    store.setItem(COMMENT_REACTIONS_STORAGE_KEY, JSON.stringify(reactions))
}

export async function fetchUploadComments(
    uploadId: string,
    apiEndpoint: string,
    fetcher: typeof fetch = fetch,
    forwarded: Record<string, string> = {}
): Promise<CommentPublic[]> {
    const response = await apiFetch(fetcher,
        joinApiPath(apiEndpoint, `/api/v2/uploads/${encodeURIComponent(uploadId)}/comments`),
        { headers: { Accept: 'application/json', ...forwarded } }
    )

    const comments = await readApiJson(response, (value): value is CommentPublic[] => {
        return Array.isArray(value) && value.every(isCommentPublic)
    })
    return comments
}

export async function createUploadComment(
    uploadId: string,
    apiEndpoint: string,
    body: CommentCreateBody,
    clientUuid: string,
    fetcher: typeof fetch = fetch
): Promise<CommentPublic> {
    if (!isClientUuid(clientUuid))
        throw new Error("Comments not ready. Reload the page.")

    const response = await apiFetch(fetcher,
        joinApiPath(apiEndpoint, `/api/v2/uploads/${encodeURIComponent(uploadId)}/comments`),
        {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'X-Client-UUID': clientUuid
            },
            body: JSON.stringify(body)
        }
    )

    if (response.status !== 201)
        throw await apiErrorFromResponse(response)

    const comment = await response.json().catch(() => null) as unknown
    if (!isCommentPublic(comment))
        throw new ApiError(response.status, BAD_RESPONSE)

    return comment
}

export async function updateCommentReaction(
    commentId: string,
    apiEndpoint: string,
    state: CommentReactionState,
    clientUuid: string,
    fetcher: typeof fetch = fetch
): Promise<CommentPublic> {
    if (!isCommentId(commentId))
        throw new Error("Invalid comment.")
    if (!isClientUuid(clientUuid))
        throw new Error("Comments not ready. Reload the page.")
    if (!isReactionState(state))
        throw new Error("Invalid reaction.")

    const response = await apiFetch(fetcher,
        joinApiPath(apiEndpoint, `/api/v2/comments/${encodeURIComponent(commentId)}/reactions`),
        {
            method: 'PUT',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'X-Client-UUID': clientUuid
            },
            body: JSON.stringify(state)
        }
    )

    return readApiJson(response, isCommentPublic)
}

function defaultStorage(): StorageLike {
    if (typeof localStorage === 'undefined')
        throw new Error("Local storage is blocked.")
    return localStorage
}
