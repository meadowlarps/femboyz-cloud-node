<script lang="ts">
    import { onMount } from 'svelte'
    import { spawnAlert } from '$lib/alerts'
    import {
        type CommentPublic,
        type CommentReactionState,
        createUploadComment,
        getOrCreateClientUuid,
        readCommentReactions,
        updateCommentReaction as putCommentReaction,
        writeCommentReaction
    } from '$lib/upload/comments'
    import ReactionCount from './ReactionCount.svelte'

    export type { CommentPublic as Comment } from '$lib/upload/comments'

    type DisplayComment = CommentPublic & {
        user_reaction: CommentReactionState
    }

    let {
        comments: initialComments,
        upload_id,
        api_endpoint
    }: {
        comments: CommentPublic[]
        upload_id: string
        api_endpoint: string
    } = $props()

    let comments = $state<DisplayComment[]>([])
    let comment_draft = $state('')
    let reply_to = $state<DisplayComment>()
    let highlighted_comment_id = $state<string>()
    let submit_pending = $state(false)
    let reaction_pending = $state<Record<string, boolean>>({})
    let seeded_upload_id = $state('')

    let client_uuid = $state('')
    let comment_input: HTMLTextAreaElement

    function defaultReaction(): CommentReactionState {
        return { rating: null, eyes: false }
    }

    function comment_with_reaction(comment: CommentPublic, reaction: CommentReactionState): DisplayComment {
        return { ...comment, user_reaction: reaction }
    }

    function comments_from_source(source: CommentPublic[], stored: Record<string, CommentReactionState>): DisplayComment[] {
        return source.map(comment => comment_with_reaction(comment, stored[comment.id] ?? defaultReaction()))
    }

    $effect.pre(() => {
        if (seeded_upload_id === upload_id) return
        seeded_upload_id = upload_id
        const stored = typeof window !== 'undefined' ? readCommentReactions() : {}
        comments = comments_from_source(initialComments, stored)
    })

    onMount(() => {
        try {
            client_uuid = getOrCreateClientUuid()
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Could not initialize comments'
            spawnAlert('error', message)
        }
    })


    function comment_reply(comment: DisplayComment) {
        reply_to = comment
        comment_input?.focus()
    }

    function comment_reply_cancel() {
        reply_to = undefined
        highlighted_comment_id = undefined
    }

    function comment_highlight(id?: string) {
        highlighted_comment_id = id
    }

    function comment_reply_identifier(id: string) {
        return comments.find(comment => comment.id === id)?.id ?? 'unknown'
    }

    function reaction_is_pending(commentId: string) {
        return Boolean(reaction_pending[commentId])
    }

    async function reaction_apply(comment: DisplayComment, desired: CommentReactionState) {
        if (reaction_is_pending(comment.id)) return

        reaction_pending = { ...reaction_pending, [comment.id]: true }
        try {
            const uuid = client_uuid || getOrCreateClientUuid()
            const updated = await putCommentReaction(comment.id, api_endpoint, desired, uuid)
            comments = comments.map(item => item.id === comment.id
                ? comment_with_reaction(updated, desired)
                : item)
            try {
                writeCommentReaction(comment.id, desired)
            } catch {
                spawnAlert('error', 'Could not save reaction for reload')
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to update reaction'
            spawnAlert('error', message)
        } finally {
            const next = { ...reaction_pending }
            delete next[comment.id]
            reaction_pending = next
        }
    }

    function reaction_vote(comment: DisplayComment, vote: 'up' | 'down') {
        const current = comment.user_reaction
        void reaction_apply(comment, {
            rating: current.rating === vote ? null : vote,
            eyes: current.eyes
        })
    }

    function reaction_eyes(comment: DisplayComment) {
        const current = comment.user_reaction
        void reaction_apply(comment, {
            rating: current.rating,
            eyes: !current.eyes
        })
    }

    async function comment_submit(event: SubmitEvent) {
        event.preventDefault()

        const content = comment_draft.trim()
        if (!content || submit_pending) return

        submit_pending = true
        try {
            const uuid = client_uuid || getOrCreateClientUuid()
            const created = await createUploadComment(
                upload_id,
                api_endpoint,
                {
                    content,
                    ...(reply_to === undefined ? {} : { id_reply_to: reply_to.id })
                },
                uuid
            )
            comments = [...comments, comment_with_reaction(created, defaultReaction())]
            comment_draft = ''
            reply_to = undefined
            highlighted_comment_id = undefined
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to post comment'
            spawnAlert('error', message)
        } finally {
            submit_pending = false
        }
    }

    function comment_format_when(iso: string) {
        return new Date(iso).toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
        })
    }
</script>

<section class="comments" aria-label="Comments">
    <h2>Comments</h2>
    {#if comments.length === 0}
        <p class="empty">No comments yet.</p>
    {:else}
        <ol>
            {#each comments as comment (comment.id)}
                <li
                    id={`comment-${comment.id}`}
                    class:related-highlight={comment.id === highlighted_comment_id}
                >
                    <div class="meta">
                        <div class="identifier-chain">
                            <span class="identifier">{comment.id}</span>
                            {#if comment.id_reply_to}
                                <svg class="reply-arrow" viewBox="0 0 16 16" aria-hidden="true">
                                    <path d="M2.5 8h10M9 4.5 12.5 8 9 11.5" />
                                </svg>
                                <a
                                    class="reply-target"
                                    href={`#comment-${comment.id_reply_to}`}
                                    onmouseenter={() => comment_highlight(comment.id_reply_to)}
                                    onmouseleave={() => comment_highlight()}
                                    onfocus={() => comment_highlight(comment.id_reply_to)}
                                    onblur={() => comment_highlight()}
                                >
                                    {comment_reply_identifier(comment.id_reply_to)}
                                </a>
                            {/if}
                        </div>
                        <time datetime={comment.when}>{comment_format_when(comment.when)}</time>
                    </div>
                    <p class="body">{comment.content}</p>
                    <div class="reactions" aria-label="Reactions">
                        <div
                            class="vote-block"
                            class:selected={comment.user_reaction.rating !== null}
                            aria-label={`Score: ${comment.stat.up - comment.stat.down}`}
                        >
                            <button
                                class="vote-btn"
                                class:selected={comment.user_reaction.rating === 'up'}
                                type="button"
                                title="Up"
                                aria-label="Upvote"
                                aria-pressed={comment.user_reaction.rating === 'up'}
                                disabled={reaction_is_pending(comment.id)}
                                onclick={() => reaction_vote(comment, 'up')}
                            >↑</button>
                            <span class="vote-score">
                                <ReactionCount value={comment.stat.up - comment.stat.down} />
                            </span>
                            <button
                                class="vote-btn"
                                class:selected={comment.user_reaction.rating === 'down'}
                                type="button"
                                title="Down"
                                aria-label="Downvote"
                                aria-pressed={comment.user_reaction.rating === 'down'}
                                disabled={reaction_is_pending(comment.id)}
                                onclick={() => reaction_vote(comment, 'down')}
                            >↓</button>
                        </div>
                        <button
                            class="reaction"
                            class:selected={comment.user_reaction.eyes}
                            type="button"
                            aria-label={`${comment.stat.eyes} eyes reactions`}
                            aria-pressed={comment.user_reaction.eyes}
                            title="Eyes"
                            disabled={reaction_is_pending(comment.id)}
                            onclick={() => reaction_eyes(comment)}
                        >
                            <span aria-hidden="true">👀</span>
                            <span class="reaction-count"><ReactionCount value={comment.stat.eyes} /></span>
                        </button>
                        <button class="reply-button" type="button" onclick={() => comment_reply(comment)}>
                            Reply
                        </button>
                    </div>
                </li>
            {/each}
        </ol>
    {/if}

    <form class="comment-form" onsubmit={comment_submit}>
        {#if reply_to}
            <div class="reply-context">
                <span>
                    Replying to
                    <a
                        class="reply-target"
                        href={`#comment-${reply_to.id}`}
                        onmouseenter={() => comment_highlight(reply_to?.id)}
                        onmouseleave={() => comment_highlight()}
                        onfocus={() => comment_highlight(reply_to?.id)}
                        onblur={() => comment_highlight()}
                    >
                        {reply_to.id}
                    </a>
                </span>
                <button
                    class="reply-cancel"
                    type="button"
                    aria-label={`Cancel reply to ${reply_to.id}`}
                    onclick={comment_reply_cancel}
                >
                    Cancel
                </button>
            </div>
        {/if}
        <textarea
            class="comment-input"
            bind:this={comment_input}
            bind:value={comment_draft}
            aria-label="Write a comment"
            placeholder="Write a comment..."
            rows="3"
            disabled={submit_pending}
        ></textarea>
        <button class="send-button" type="submit" disabled={!comment_draft.trim() || submit_pending}>
            {submit_pending ? 'Sending…' : 'Send'}
        </button>
    </form>
</section>

<style>
    .comments {
        display: grid;
        gap: 0.5rem;
        min-width: 0;
        padding: 0.75rem;
        border: 1px solid #2e2b2c;
    }

    h2 {
        margin: 0.25rem 0 0.75rem 0;
        padding: 0 0.25rem;
        font-size: 1rem;
        font-weight: 700;
    }

    ol {
        display: grid;
        gap: 0.65rem;
        margin: 0;
        padding: 0;
        list-style: none;
    }
    li {
        display: grid;
        gap: 0.2rem;
        padding: 0.55rem 0.6rem;
        border: 1px solid #3b3538;
        scroll-margin-top: 5rem;
        transition: background-color 0.15s ease, border-color 0.15s ease;
    }

    li.related-highlight {
        background: rgb(195 15 69 / 8%);
        border-color: var(--color-accent);
    }
    .meta {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.75rem;
        flex-wrap: wrap;
    }

    .identifier {
        color: #8a8385;
        font-size: 0.85rem;
        font-weight: 400;
        font-variant-numeric: tabular-nums;
    }

    .identifier-chain {
        display: flex;
        align-items: center;
        gap: 0.3rem;
        min-width: 0;
        font-size: 0.85rem;
    }

    .identifier-chain .reply-target {
        color: #8a8385;
        font-weight: 400;
    }

    .reply-arrow {
        width: 0.8rem;
        height: 0.8rem;
        flex-shrink: 0;
        fill: none;
        stroke: #6a6468;
        stroke-width: 1.5;
        stroke-linecap: round;
        stroke-linejoin: round;
    }

    time {
        font-size: 0.78rem;
        color: #6a6468;
        font-variant-numeric: tabular-nums;
    }

    .body {
        margin: 0;
        color: #c9c3c5;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        text-wrap: pretty;
    }

    .reactions {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        margin-top: 0.5rem;
        flex-wrap: wrap;
        user-select: none;
        -webkit-user-select: none;
    }

    .vote-block {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.15rem 0.45rem;
        border: 1px solid #3b3538;
        transition: border-color 0.15s ease;
    }

    .vote-block.selected {
        border-color: var(--color-accent);
    }

    .vote-btn {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        color: #8a8385;
        background: transparent;
        border: 0;
        font: inherit;
        font-size: 0.78rem;
        line-height: 1.2;
        cursor: pointer;
        transition: color 0.15s ease, text-shadow 0.15s ease;
    }

    .vote-btn.selected {
        color: var(--color-accent);
    }

    .vote-btn::before {
        content: '';
        position: absolute;
        inset: -0.45rem -0.4rem;
    }
    .vote-btn:hover,
    .vote-btn:focus-visible {
        color: var(--color-fb-white);
        text-shadow: 0 0 6px rgb(255 255 255 / 45%);
        outline: none;
    }

    .vote-btn:disabled,
    .reaction:disabled {
        cursor: not-allowed;
        opacity: 0.55;
    }

    .vote-btn:disabled:hover,
    .vote-btn:disabled:focus-visible,
    .reaction:disabled:hover,
    .reaction:disabled:focus-visible {
        color: #8a8385;
        border-color: #3b3538;
        box-shadow: none;
        text-shadow: none;
    }
    .vote-score {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #8a8385;
        font-size: 0.78rem;
        line-height: 1.2;
        font-variant-numeric: tabular-nums;
    }

    .reaction {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.15rem 0.45rem;
        color: #8a8385;
        background: transparent;
        border: 1px solid #3b3538;
        font: inherit;
        font-size: 0.78rem;
        line-height: 1.2;
        font-variant-numeric: tabular-nums;
        cursor: pointer;
        transition: color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, text-shadow 0.15s ease;
    }

    .reaction.selected {
        color: var(--color-accent);
        border-color: var(--color-accent);
    }

    .reaction-count {
        color: #8a8385;
        transition: color 0.15s ease;
    }

    .reaction.selected .reaction-count {
        color: #8a8385;
    }

    .reaction:hover,
    .reaction:focus-visible {
        color: var(--color-fb-white);
        border-color: var(--color-fb-white);
        box-shadow: 0 0 6px rgb(255 255 255 / 30%);
        text-shadow: 0 0 5px rgb(255 255 255 / 35%);
        outline: none;
    }

    .reaction:hover .reaction-count,
    .reaction:focus-visible .reaction-count {
        color: var(--color-fb-white);
    }

    .reply-button {
        padding: 0.15rem 0.45rem;
        color: #8a8385;
        background: transparent;
        border: 1px solid #3b3538;
        font: inherit;
        font-size: 0.78rem;
        line-height: 1.2;
        cursor: pointer;
        transition: color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, text-shadow 0.15s ease;
    }

    .reply-button:hover,
    .reply-button:focus-visible {
        color: var(--color-fb-white);
        border-color: var(--color-fb-white);
        box-shadow: 0 0 6px rgb(255 255 255 / 30%);
        text-shadow: 0 0 5px rgb(255 255 255 / 35%);
        outline: none;
    }

    .reply-cancel {
        padding: 0.15rem 0.35rem;
        color: #8a8385;
        background: transparent;
        border: 0;
        font: inherit;
        font-size: 0.78rem;
        line-height: 1.2;
        cursor: pointer;
        transition: color 0.15s ease, text-shadow 0.15s ease;
    }

    .reply-cancel:hover,
    .reply-cancel:focus-visible {
        color: var(--color-fb-white);
        text-shadow: 0 0 5px rgb(255 255 255 / 35%);
        outline: none;
    }


    .reply-target {
        color: var(--color-fb-white);
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        text-decoration: none;
        transition: color 0.15s ease;
    }

    .reply-target:hover,
    .reply-target:focus-visible {
        color: var(--color-accent);
        outline: none;
    }

    .comment-form {
        display: grid;
        gap: 0.5rem;
        margin-top: 0.5rem;
        padding-top: 0.75rem;
        border-top: 1px solid #2e2b2c;
    }

    .reply-context {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.4rem;
        padding: 0 0.15rem;
        color: #8a8385;
        font-size: 0.8rem;
    }

    .reply-context .reply-target {
        color: var(--color-fb-white);
    }

    .reply-context .reply-target:hover,
    .reply-context .reply-target:focus-visible {
        color: var(--color-accent);
    }

    .comment-input {
        box-sizing: border-box;
        width: 100%;
        min-height: 4.5rem;
        padding: 0.55rem 0.65rem;
        resize: vertical;
        color: #c9c3c5;
        background: #181617;
        border: 1px solid #3b3538;
        font: inherit;
        line-height: 1.4;
    }

    .comment-input::placeholder {
        color: #6a6468;
    }

    .comment-input:focus-visible {
        border-color: var(--color-fb-white);
        box-shadow: 0 0 5px rgb(255 255 255 / 18%);
    }

    .send-button {
        justify-self: end;
        padding: 0.4rem 0.85rem;
        color: var(--color-fb-white);
        background: var(--color-accent);
        border: 1px solid var(--color-accent);
        font: inherit;
        font-size: 0.85rem;
        font-weight: 700;
        cursor: pointer;
        transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
    }

    .send-button:hover,
    .send-button:focus-visible {
        color: #060606;
        background: var(--color-fb-white);
        border-color: var(--color-fb-white);
        outline: none;
    }

    .send-button:disabled {
        color: #6a6468;
        background: transparent;
        border-color: #3b3538;
        cursor: not-allowed;
    }
    .empty {
        margin: 0;
        padding: 0.25rem;
        color: #6a6468;
        font-size: 0.85rem;
    }
</style>
