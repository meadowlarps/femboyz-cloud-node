import type { UploadData } from './downloader.js'

/** Feed items carry the same public fields as an upload, minus the `public` flag. */
export type FeedItem = Omit<UploadData, 'public'>

export type FeedResponse = {
    items: FeedItem[]
    start: number
    end: number
    total: number
    has_more: boolean
}

export const FEED_PAGE_SIZE = 20

export async function fetchFeed(
    apiEndpoint: string,
    start: number,
    end: number,
    fetcher: typeof fetch = fetch,
    forwarded: Record<string, string> = {}
): Promise<FeedResponse> {
    const response = await fetcher(
        `${apiEndpoint.replace(/\/$/, '')}/api/v2/feed?s=${start}&e=${end}`,
        { headers: forwarded }
    )

    if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`)
    }

    return await response.json() as FeedResponse
}

/** Fetches `[0, end)` of the feed, chunked into requests of at most 100 items. */
export async function fetchFeedRange(
    apiEndpoint: string,
    end: number,
    fetcher: typeof fetch = fetch
): Promise<FeedResponse> {
    const items: FeedItem[] = []
    let last: FeedResponse | undefined

    for (let start = 0; start < end; start += 100) {
        last = await fetchFeed(apiEndpoint, start, Math.min(end, start + 100), fetcher)
        items.push(...last.items)
    }

    return last
        ? { ...last, items, start: 0, end }
        : { items: [], start: 0, end: 0, total: 0, has_more: false }
}
