import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { renderWithProviders } from './helpers'
import ChatInput from '../components/ChatInput'

/**
 * The empty-composer ⌘↩ gesture while a card is queued: it steers the FRONT
 * queued card into the running turn (the Codex desktop behaviour), and the
 * composer's placeholder is the one place that advertises it.
 *
 * Mutation checks (each makes a test below RED):
 *  - drop the placeholder gate on queuedCount          -> "keeps the default placeholder with nothing queued"
 *  - drop the gate on the busy split                    -> "keeps the default placeholder while idle"
 *  - fire fireComposer before the queued-front branch   -> "⌘↩ on an empty composer steers the front card"
 *  - steer the front card even with a draft present     -> "⌘↩ with a draft flips the draft, not the queue"
 */
const busyProps = {
  value: '',
  onChange: vi.fn(),
  onSend: vi.fn(),
  isRunning: true,
  canSteer: true,
  onSteer: vi.fn(),
  connected: true,
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

const placeholderOf = () => (screen.getByRole('textbox') as HTMLTextAreaElement).placeholder

describe('ChatInput queued-steer affordance', () => {
  it('names the chord in the placeholder while busy with a card queued', () => {
    renderWithProviders(<ChatInput {...busyProps} onSteerFrontQueued={() => true} queuedCount={1} />)
    expect(placeholderOf()).toMatch(/steers the front queued message/)
  })

  it('keeps the default placeholder with nothing queued', () => {
    renderWithProviders(<ChatInput {...busyProps} onSteerFrontQueued={() => false} queuedCount={0} />)
    expect(placeholderOf()).not.toMatch(/queued message/)
  })

  it('keeps the default placeholder while idle even with a stale count', () => {
    renderWithProviders(<ChatInput {...busyProps} isRunning={false} onSteerFrontQueued={() => true} queuedCount={2} />)
    expect(placeholderOf()).not.toMatch(/queued message/)
  })

  it('⌘↩ on an empty composer steers the front card and does not send', () => {
    const onSteerFrontQueued = vi.fn(() => true)
    renderWithProviders(<ChatInput {...busyProps} onSteerFrontQueued={onSteerFrontQueued} queuedCount={1} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true })
    expect(onSteerFrontQueued).toHaveBeenCalledTimes(1)
    expect(busyProps.onSteer).not.toHaveBeenCalled()
    expect(busyProps.onSend).not.toHaveBeenCalled()
  })

  it('⌘↩ with a draft flips the draft (steer↔queue), leaving the queue alone', () => {
    const onSteerFrontQueued = vi.fn(() => true)
    const onSend = vi.fn()
    renderWithProviders(
      <ChatInput {...busyProps} value="a new instruction" onSend={onSend} onSteerFrontQueued={onSteerFrontQueued} queuedCount={1} />,
    )
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true })
    expect(onSteerFrontQueued).not.toHaveBeenCalled()
    // Default busy mode is steer, so the one-off flip queues: a plain onSend.
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('falls through to the ordinary key handling when the front steer reports nothing queued', () => {
    const onSteerFrontQueued = vi.fn(() => false)
    renderWithProviders(<ChatInput {...busyProps} onSteerFrontQueued={onSteerFrontQueued} queuedCount={0} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true })
    expect(onSteerFrontQueued).toHaveBeenCalledTimes(1)
    // Empty draft: the flip lands on onSend, whose own emptiness guard is the host's.
    expect(busyProps.onSend).toHaveBeenCalledTimes(1)
  })
})
