import { render, act, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import chatReducer from '../store/chatSlice'
import dashboardReducer from '../store/dashboardSlice'
import notificationsReducer from '../store/notificationsSlice'
import type { RootState } from '../store'
import type { ChatMessage } from '../types'

/* Pins for the queue-card STEER action: "act on this queued message now, without
 * interrupting the running turn" — the non-interrupting sibling of onInterrupt.
 *
 * One server call (`POST …/queue/{id}/steer`). The route owns take-then-steer and
 * put-back, so the client is deliberately NOT optimistic: it retires the card
 * only on `steered`, and otherwise leaves the store to the server's frames.
 *
 * Mutation checks (each makes a test below RED):
 *  - retire the card before the response              -> "retires the card only once the server says steered"
 *  - retire the card on `queued`                       -> "leaves the card alone when the turn could not take it"
 *  - restore the composer on a rejection               -> "releases the card on a rejection without touching the composer"
 *  - onSteerFront picks allQueued[0]                   -> "steers the FRONT VISIBLE card"
 */

const deferred = <T,>() => {
  let resolve!: (v: T) => void
  let reject!: (e?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const apiMocks = vi.hoisted(() => ({
  cancelQueuedMessage: vi.fn(),
  editQueuedMessage: vi.fn(),
  interruptSlot: vi.fn(),
  reorderQueuedMessages: vi.fn(),
  steerQueuedMessage: vi.fn(),
}))
vi.mock('../api/client', () => ({ api: apiMocks }))

import { useQueuedMessageActions, queuedSendStash, type QueuedMessageActions } from '../hooks/useQueuedMessageActions'

const queued = (queueId: string, content: string): ChatMessage =>
  ({ role: 'queued', content, cls: 'msg msg-queued', ts: '', meta: { queueId } }) as ChatMessage

function makeStore(slot: string, rows: ChatMessage[]) {
  return configureStore({
    reducer: { dashboard: dashboardReducer, chat: chatReducer, notifications: notificationsReducer },
    preloadedState: {
      chat: { activeSlot: slot, messages: rows, slotMessages: {} },
    } as unknown as Partial<RootState>,
  })
}

function renderActions(opts: {
  rows?: ChatMessage[]
  visible?: ChatMessage[]
  restoreDraft?: (text: string, files: string[]) => void
}) {
  const rows = opts.rows ?? [queued('q1', 'run the tests'), queued('q2', 'then deploy')]
  const slot = 'chat-1'
  const store = makeStore(slot, rows)
  let actions: QueuedMessageActions | null = null

  function Probe() {
    actions = useQueuedMessageActions({
      slot,
      allQueued: rows,
      visibleQueued: opts.visible ?? rows,
      restoreDraft: opts.restoreDraft,
    })
    return null
  }
  render(<Provider store={store}><Probe /></Provider>)
  return { store, get: () => actions! }
}

const queueIdsIn = (store: ReturnType<typeof makeStore>) =>
  (store.getState() as RootState).chat.messages.filter(m => m.role === 'queued').map(m => m.meta?.queueId)

beforeEach(() => {
  vi.clearAllMocks()
  queuedSendStash.clear()
  for (const fn of Object.values(apiMocks)) fn.mockResolvedValue({ ok: true })
  apiMocks.steerQueuedMessage.mockResolvedValue({ ok: true, steered: true })
})

describe('useQueuedMessageActions — steer', () => {
  it('retires the card only once the server says steered', async () => {
    const d = deferred<{ ok: boolean; steered?: boolean }>()
    apiMocks.steerQueuedMessage.mockReturnValue(d.promise)
    const { get, store } = renderActions({})
    act(() => { get().onSteer('q1') })
    expect(apiMocks.steerQueuedMessage).toHaveBeenCalledWith('chat-1', 'q1')
    // Latched while in flight; card still on screen — the server decides.
    expect(get().pendingIds.has('q1')).toBe(true)
    expect(queueIdsIn(store)).toEqual(['q1', 'q2'])
    await act(async () => { d.resolve({ ok: true, steered: true }) })
    await waitFor(() => expect(queueIdsIn(store)).toEqual(['q2']))
    await waitFor(() => expect(get().pendingIds.has('q1')).toBe(false))
    // Never routed through the interrupting sibling or the plain cancel.
    expect(apiMocks.interruptSlot).not.toHaveBeenCalled()
    expect(apiMocks.cancelQueuedMessage).not.toHaveBeenCalled()
  })

  it('leaves the card alone when the turn could not take it (queued)', async () => {
    apiMocks.steerQueuedMessage.mockResolvedValue({ ok: true, steered: false, queued: true, queue_id: 'q1' })
    const restoreDraft = vi.fn()
    const { get, store } = renderActions({ restoreDraft })
    act(() => { get().onSteer('q1') })
    await waitFor(() => expect(get().pendingIds.has('q1')).toBe(false))
    // Same entry, same id, same place on the server — so the same card here.
    expect(queueIdsIn(store)).toEqual(['q1', 'q2'])
    expect(restoreDraft).not.toHaveBeenCalled()
  })

  it('releases the card on a rejection without touching the composer', async () => {
    apiMocks.steerQueuedMessage.mockRejectedValue(new Error('404 queue item not found'))
    const restoreDraft = vi.fn()
    const { get, store } = renderActions({ restoreDraft })
    act(() => { get().onSteer('q1') })
    await waitFor(() => expect(get().pendingIds.has('q1')).toBe(false))
    // The drain (or another client) already took it; the server's frame owns the card.
    expect(queueIdsIn(store)).toEqual(['q1', 'q2'])
    expect(restoreDraft).not.toHaveBeenCalled()
  })

  it('consumes the send-time stash on steered so a later cancel cannot restore stale state', async () => {
    queuedSendStash.set('q1', { raw: 'run the tests', files: [], sent: 'run the tests' })
    const { get } = renderActions({})
    act(() => { get().onSteer('q1') })
    await waitFor(() => expect(queuedSendStash.has('q1')).toBe(false))
  })

  it('does nothing without a slot', () => {
    const rows = [queued('q1', 'x')]
    const store = makeStore('chat-1', rows)
    let actions: QueuedMessageActions | null = null
    function Probe() {
      actions = useQueuedMessageActions({ slot: null, allQueued: rows, visibleQueued: rows })
      return null
    }
    render(<Provider store={store}><Probe /></Provider>)
    act(() => { actions!.onSteer('q1') })
    expect(apiMocks.steerQueuedMessage).not.toHaveBeenCalled()
  })
})

describe('useQueuedMessageActions — steer front', () => {
  it('steers the FRONT VISIBLE card and reports it did', async () => {
    // A hidden system delivery sits at the front of the full queue; the visible
    // front is q2. The gesture acts on what the user can see.
    const rows = [queued('sys', '[Subagent completion event] done'), queued('q2', 'then deploy')]
    const { get } = renderActions({ rows, visible: [rows[1]] })
    let handled = false
    act(() => { handled = get().onSteerFront() })
    expect(handled).toBe(true)
    expect(apiMocks.steerQueuedMessage).toHaveBeenCalledWith('chat-1', 'q2')
  })

  it('reports false with nothing queued so the key falls through', () => {
    const { get } = renderActions({ rows: [], visible: [] })
    let handled = true
    act(() => { handled = get().onSteerFront() })
    expect(handled).toBe(false)
    expect(apiMocks.steerQueuedMessage).not.toHaveBeenCalled()
  })
})
