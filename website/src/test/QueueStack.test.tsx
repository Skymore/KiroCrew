import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import QueueStack, { SubagentDeliveryProgress, isSystemDelivery, isNonInteractiveQueued } from '../components/QueueStack'
import type { ChatMessage } from '../types'

// QueueStack renders framer-motion cards; we only exercise the inline
// EditInput, which is plain DOM and needs no special test polyfill.

function queued(content: string, queueId: string): ChatMessage {
  return { role: 'queued', content, cls: 'msg msg-queued', ts: '', meta: { queueId } } as ChatMessage
}

/** Open the inline editor on the single queued card and return its input. */
function openEditor() {
  const pencil = screen.getByLabelText('Edit queued message')
  fireEvent.click(pencil)
  return screen.getByLabelText('Edit queued message') as HTMLTextAreaElement
}

describe('QueueStack expanded order', () => {
  it('puts the collapse chevron on the LAST card, which is now the bottom of the run-order list', () => {
    // The y positions are spring-animated by framer-motion, which jsdom cannot
    // settle synchronously, so the visual order is pinned structurally: the
    // collapse chevron is attached to whichever card renders at the bottom.
    const { container } = render(
      <QueueStack messages={[queued('first', 'q1'), queued('second', 'q2'), queued('third', 'q3')]} onReorder={vi.fn()} />,
    )
    const toggle = container.querySelector('[role="button"]')!
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const cards = Array.from(container.querySelectorAll('.queue-card')) as HTMLElement[]
    const byText = (t: string) => cards.find(c => c.textContent?.includes(t))!
    expect(byText('third').querySelector('.rotate-180')).not.toBeNull()
    expect(byText('first').querySelector('.rotate-180')).toBeNull()
  })

  it('disables "run sooner" on the top card and "run later" on the bottom card', () => {
    const onReorder = vi.fn()
    const { container } = render(
      <QueueStack messages={[queued('first', 'q1'), queued('second', 'q2')]} onReorder={onReorder} />,
    )
    fireEvent.click(container.querySelector('[role="button"]')!)
    const sooner = screen.getAllByLabelText('Run sooner') as HTMLButtonElement[]
    const later = screen.getAllByLabelText('Run later') as HTMLButtonElement[]
    // Index 0 (top) cannot move sooner; the last (bottom) cannot move later.
    expect(sooner[0].disabled).toBe(true)
    expect(later[1].disabled).toBe(true)
    fireEvent.click(sooner[1])
    expect(onReorder).toHaveBeenCalledWith('q2', 'next')
  })
})

describe('QueueStack action row (max two controls)', () => {
  const all = () => ({
    onSteer: vi.fn(), onInterrupt: vi.fn(), onEdit: vi.fn(), onCancel: vi.fn(), onReorder: vi.fn(),
  })

  it('keeps Steer inline and folds every other action into one overflow menu', async () => {
    const h = all()
    render(<QueueStack messages={[queued('act on this', 'q1')]} {...h} />)
    // Exactly two controls in the row: the primary action and the trigger.
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.getByLabelText('Steer now')).toBeInTheDocument()
    expect(screen.getByLabelText('More actions')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel queued message' })).toBeNull()
    fireEvent.keyDown(screen.getByLabelText('More actions'), { key: 'Enter' })
    const items = await screen.findAllByRole('menuitem')
    expect(items.map(i => i.textContent)).toEqual(['Send now', 'Edit queued message', 'Cancel queued message'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Send now' }))
    expect(h.onInterrupt).toHaveBeenCalledWith('q1')
    expect(h.onSteer).not.toHaveBeenCalled()
  })

  it('offers the reorder actions in the menu only when expanded with 2+ cards', async () => {
    const h = all()
    const { container } = render(<QueueStack messages={[queued('first', 'q1'), queued('second', 'q2')]} {...h} />)
    fireEvent.click(container.querySelector('[role="button"]')!)
    const triggers = screen.getAllByLabelText('More actions')
    fireEvent.keyDown(triggers[1], { key: 'Enter' })
    await screen.findByRole('menuitem', { name: 'Run sooner' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run sooner' }))
    expect(h.onReorder).toHaveBeenCalledWith('q2', 'next')
  })

  it('opening the menu by pointer does not toggle the stack', async () => {
    const h = all()
    const { container } = render(<QueueStack messages={[queued('first', 'q1'), queued('second', 'q2')]} {...h} />)
    const toggle = container.querySelector('[role="button"]')!
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const trigger = screen.getAllByLabelText('More actions')[0]
    // The container toggles on click, so a trigger click that bubbled would
    // fold the stack the user is looking at.
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    await screen.findAllByRole('menuitem')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('opening the menu by keyboard does not toggle the stack', async () => {
    const h = all()
    const { container } = render(<QueueStack messages={[queued('first', 'q1'), queued('second', 'q2')]} {...h} />)
    const toggle = container.querySelector('[role="button"]')!
    fireEvent.click(toggle)
    const trigger = screen.getAllByLabelText('More actions')[0]
    // The container also toggles on Enter/Space.
    fireEvent.keyDown(trigger, { key: 'Enter' })
    await screen.findAllByRole('menuitem')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('renders two actions inline with no menu (the side chat: edit + cancel)', () => {
    const onEdit = vi.fn()
    const onCancel = vi.fn()
    render(<QueueStack messages={[queued('side', 'q1')]} onEdit={onEdit} onCancel={onCancel} />)
    expect(screen.queryByLabelText('More actions')).toBeNull()
    expect(screen.getByLabelText('Edit queued message')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Cancel queued message'))
    expect(onCancel).toHaveBeenCalledWith('q1')
  })

  it('the trigger goes dark with the card while pending', () => {
    const h = all()
    render(<QueueStack messages={[queued('act on this', 'q1')]} {...h} pendingIds={new Set(['q1'])} />)
    expect((screen.getByLabelText('More actions') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Steer now') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('QueueStack steer-now button', () => {
  it('is the inline action and fires onSteer with the card id', () => {
    const onSteer = vi.fn()
    const onInterrupt = vi.fn()
    render(<QueueStack messages={[queued('act on this', 'q1')]} onSteer={onSteer} onInterrupt={onInterrupt} />)
    fireEvent.click(screen.getByLabelText('Steer now'))
    expect(onSteer).toHaveBeenCalledWith('q1')
    // Steer never routes through the interrupting sibling.
    expect(onInterrupt).not.toHaveBeenCalled()
  })

  it('is absent when the host provides no steer path, and Send now takes the inline slot', () => {
    render(<QueueStack messages={[queued('act on this', 'q1')]} onInterrupt={vi.fn()} />)
    expect(screen.queryByLabelText('Steer now')).toBeNull()
    expect(screen.getByLabelText('Send now')).toBeInTheDocument()
  })

  it('is disabled while the card is pending', () => {
    const onSteer = vi.fn()
    render(<QueueStack messages={[queued('act on this', 'q1')]} onSteer={onSteer} pendingIds={new Set(['q1'])} />)
    const btn = screen.getByLabelText('Steer now') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onSteer).not.toHaveBeenCalled()
  })
})

describe('QueueStack inline edit', () => {
  it('commits a real change on Enter', () => {
    const onEdit = vi.fn()
    render(<QueueStack messages={[queued('old text', 'q1')]} onEdit={onEdit} />)
    const input = openEditor()
    fireEvent.change(input, { target: { value: 'new text' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledWith('q1', 'new text')
  })

  it('does NOT fire onEdit when the text is unchanged and the input blurs (no-op edit)', () => {
    const onEdit = vi.fn()
    render(<QueueStack messages={[queued('same text', 'q1')]} onEdit={onEdit} />)
    const input = openEditor()
    // User clicks in, clicks away without changing anything.
    fireEvent.blur(input)
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('does NOT fire onEdit when the input is cleared and blurred (empty no-op)', () => {
    const onEdit = vi.fn()
    render(<QueueStack messages={[queued('something', 'q1')]} onEdit={onEdit} />)
    const input = openEditor()
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('does NOT fire onEdit on Escape (cancel), even after editing', () => {
    const onEdit = vi.fn()
    render(<QueueStack messages={[queued('old', 'q1')]} onEdit={onEdit} />)
    const input = openEditor()
    fireEvent.change(input, { target: { value: 'changed but cancelled' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('is a textarea that keeps the newlines between attachment markers through an edit', () => {
    // The serializer writes one `[attached_file N] path` marker per line. A
    // single-line <input> drops every newline from its value, which would
    // glue the markers together and make the queue edit prune all but the
    // last attachment (a card resolving to a path the agent never received).
    const onEdit = vi.fn()
    const twoFiles = 'caption\n[attached_file 1] /tmp/a.pdf\n[attached_file 2] /tmp/My Report.pdf'
    render(<QueueStack messages={[queued(twoFiles, 'q1')]} onEdit={onEdit} />)
    const editor = openEditor()
    expect(editor.tagName).toBe('TEXTAREA')
    expect(editor.value).toBe(twoFiles)
    // The card is a fixed-height stack slot, so the editor stays one visible row.
    expect(editor.getAttribute('rows')).toBe('1')
    // Only the caption line is selected: a retype replaces the caption, never
    // the marker lines hidden below the visible row.
    expect(editor.selectionStart).toBe(0)
    expect(editor.selectionEnd).toBe('caption'.length)
    // The hidden lines are named next to the editor so the value below the
    // fold is never a surprise -- and named as what they are: every hidden
    // line here is an attachment marker, so the cue says attachments.
    expect(screen.getByTestId('queue-edit-hidden-lines').textContent).toBe('+2 attachments')
    const edited = 'new caption\n[attached_file 1] /tmp/a.pdf\n[attached_file 2] /tmp/My Report.pdf'
    fireEvent.change(editor, { target: { value: edited } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onEdit).toHaveBeenCalledWith('q1', edited)
  })

  it('counts hidden lines generically when they are not all attachment markers', () => {
    const mixed = 'first line\nsecond line of prose\n[attached_file 1] /tmp/a.pdf'
    render(<QueueStack messages={[queued(mixed, 'q1')]} onEdit={vi.fn()} />)
    openEditor()
    expect(screen.getByTestId('queue-edit-hidden-lines').textContent).toBe('+2 lines')
  })

  it('shows no hidden-line cue on a single-line entry and selects the whole value', () => {
    render(<QueueStack messages={[queued('one line', 'q1')]} onEdit={vi.fn()} />)
    const editor = openEditor()
    expect(screen.queryByTestId('queue-edit-hidden-lines')).toBeNull()
    expect(editor.selectionStart).toBe(0)
    expect(editor.selectionEnd).toBe('one line'.length)
  })

  it('commits only once when Enter is followed by the trailing blur', () => {
    const onEdit = vi.fn()
    render(<QueueStack messages={[queued('old', 'q1')]} onEdit={onEdit} />)
    const input = openEditor()
    fireEvent.change(input, { target: { value: 'edited' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)  // committedRef guard must swallow this
    expect(onEdit).toHaveBeenCalledTimes(1)
  })
})

describe('system sub-agent delivery handling', () => {
  it('isSystemDelivery matches per-agent and batch completion announces only', () => {
    expect(isSystemDelivery(queued('[Subagent completion event]\nAgent `x` completed', 'q1'))).toBe(true)
    expect(isSystemDelivery(queued('[Subagent batch completion event]\nWave finished', 'q2'))).toBe(true)
    expect(isSystemDelivery(queued('please also check the docs', 'q3'))).toBe(false)
    expect(isSystemDelivery(queued('tell me about [Subagent completion event]', 'q4'))).toBe(false)
  })

  it('SubagentDeliveryProgress renders a non-interactive count line', () => {
    render(<SubagentDeliveryProgress count={42} />)
    const el = screen.getByTestId('subagent-delivery-progress')
    expect(el.textContent).toContain('42 sub-agent results ready')
    // Non-interactive: no buttons, no inputs — nothing to cancel or edit.
    expect(el.querySelector('button')).toBeNull()
    expect(el.querySelector('input')).toBeNull()
  })

  it('SubagentDeliveryProgress renders nothing at zero', () => {
    render(<SubagentDeliveryProgress count={0} />)
    expect(screen.queryByTestId('subagent-delivery-progress')).toBeNull()
  })
})

describe('isNonInteractiveQueued (composer QueueStack exclusion)', () => {
  it('excludes sub-agent completion deliveries', () => {
    expect(isNonInteractiveQueued(queued('[Subagent completion event]\nAgent `x` completed', 'q1'))).toBe(true)
    expect(isNonInteractiveQueued(queued('[Subagent batch completion event]\nWave finished', 'q2'))).toBe(true)
  })

  it('excludes synthetic turn-recovery injections (the tool-refusal composer leak)', () => {
    // Regression: a [Tool refusal — automatic recovery] injection was rendering
    // as an editable/cancellable user card in the composer QueueStack.
    expect(isNonInteractiveQueued(queued(
      '[Tool refusal — automatic recovery]\nOne or more tool calls in your previous turn were blocked.', 'q1',
    ))).toBe(true)
    expect(isNonInteractiveQueued(queued('[Stalled turn — automatic recovery]\n…', 'q2'))).toBe(true)
    expect(isNonInteractiveQueued(queued('[Tool stall — automatic recovery]\n…', 'q3'))).toBe(true)
    expect(isNonInteractiveQueued(queued('[Interrupted turn — automatic recovery]\n…', 'q4'))).toBe(true)
    expect(isNonInteractiveQueued(queued('[Empty response — automatic recovery]\n…', 'q5'))).toBe(true)
  })

  it('keeps real user-typed messages interactive', () => {
    expect(isNonInteractiveQueued(queued('please also check the docs', 'q1'))).toBe(false)
    // A user quoting the prefix mid-sentence is still a user message.
    expect(isNonInteractiveQueued(queued('why did I see [Tool refusal — automatic recovery]?', 'q2'))).toBe(false)
  })
})
