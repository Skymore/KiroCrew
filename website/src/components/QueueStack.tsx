import { useState, useRef, useEffect, memo } from 'react'
import { AnimatePresence, motion, useMotionValue, useSpring } from 'framer-motion'
import { Hourglass, ChevronUp, X, Zap, Pencil, Check, Bot, Loader2, ArrowUp, ArrowDown, Target, MoreHorizontal } from 'lucide-react'
import type { ChatMessage } from '../types'
import { useImeGuard } from '../hooks/useImeGuard'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './ui/dropdown-menu'

import { i18nT } from '../i18n/t'
import { platformShortcut } from '../utils/platform'
import { parseRecoveryMessage } from '../pages/chat/RecoveryCard'
import { hasSubagentCompletionPrefix } from '../pages/chat/subagentCompletion'
import { useLanguageGeneration } from '../i18n/useLanguageGeneration'
/** System-injected sub-agent completion deliveries waiting for the busy slot.
 *  These are NOT user messages: they must not be editable/cancellable (either
 *  would silently lose a finished agent's result) and rendering each as a
 *  queue card is noise at scale — they collapse into one progress line
 *  (SubagentDeliveryProgress) instead of the interactive QueueStack. */
export function isSystemDelivery(m: ChatMessage): boolean {
  return hasSubagentCompletionPrefix(m.content || '')
}

/** A queued entry that must NOT render as an interactive (edit/cancel) user
 *  card. Two families qualify, both machine orchestration rather than user
 *  speech:
 *    - sub-agent completion deliveries (isSystemDelivery), and
 *    - synthetic turn-recovery continuations (tool refusal / stalled turn /
 *      stalled tool / interrupted / empty response), which the gateway
 *      re-queues automatically and which surface as a compact RecoveryCard in
 *      the transcript once dequeued.
 *  Editing or cancelling either would corrupt an automatic effect, so they are
 *  filtered out of the QueueStack (sub-agent deliveries are still counted for
 *  the progress line via isSystemDelivery). */
export function isNonInteractiveQueued(m: ChatMessage): boolean {
  return isSystemDelivery(m) || parseRecoveryMessage(m.content || '') !== null
}

/** Split a slot's message list into the three things a pane surface needs:
 *  the transcript (everything not queued), the INTERACTIVE queue cards, and a
 *  count of held sub-agent deliveries for the collapsed progress line.
 *
 *  One pass, and one place. Callers own the composer's `input` state, so they
 *  re-render on every keystroke; deriving these in a render body handed the
 *  transcript array a fresh identity per character, which defeated the memo()
 *  on ChatMessageList and re-ran its O(N) turn grouping while the user typed.
 *  Callers must wrap this in a `useMemo` keyed on the input array. */
export function splitPaneMessages(allMessages: ChatMessage[]): {
  messages: ChatMessage[]
  queuedMessages: ChatMessage[]
  systemDeliveryCount: number
} {
  const messages: ChatMessage[] = []
  const queuedMessages: ChatMessage[] = []
  let systemDeliveryCount = 0
  for (const m of allMessages) {
    if (m.role !== 'queued') { messages.push(m); continue }
    // Both queue predicates are independent, not mutually exclusive: a
    // sub-agent delivery is excluded from the interactive stack AND counted
    // for the progress line.
    if (!isNonInteractiveQueued(m)) queuedMessages.push(m)
    if (isSystemDelivery(m)) systemDeliveryCount++
  }
  return { messages, queuedMessages, systemDeliveryCount }
}

/** One quiet, non-interactive line summarizing held sub-agent deliveries —
 *  "the results are in; they'll be processed when the current turn finishes". */
export function SubagentDeliveryProgress({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <div
      // `relative z-[2]` clears the transcript's bottom mask. That mask is
      // `z-[1]` and deliberately overshoots COMPOSER_MASK_OVERSHOOT_PX BELOW the
      // scrollport edge to sit flush against the composer box — an overshoot
      // sized for an EMPTY composer status stack. This bar is the first thing in
      // that stack, so at auto z-index the mask's opaque tail painted over its
      // top 10px: top border, both top corners and the first line's ascenders
      // were shaved, which reads as the card being clipped by the UI.
      className="relative z-[2] mx-auto w-full px-4"
      style={{ maxWidth: 'var(--mc-content-width, 900px)' }}
      data-testid="subagent-delivery-progress"
    >
      <div className="mb-1 flex items-center gap-2 rounded-md bg-accent/5 border border-accent/15 px-3 py-1.5 text-[12px] font-mono text-muted">
        <Bot size={13} className="text-accent/70 shrink-0" />
        <Loader2 size={12} className="animate-spin text-accent/70 shrink-0" />
        <span>
          {i18nT('components.queueStack.sub_agent_result', { count: count })} {i18nT('components.queueStack.ready_processing_after_the_current_turn')}
        </span>
      </div>
    </div>
  )
}

const MAX_PEEK = 2
const CARD_H = 40
const PEEK = 6
const EXPANDED_GAP = 4
const SCALE_STEP = 0.04
const HIDDEN_EXTRA_SCALE = 0.02
const OVERLAP = 11 // overlap to fuse with input area below

const DEPTH_BRIGHTNESS = [1, 0.88, 0.76]
const SPRING = { type: 'spring' as const, stiffness: 400, damping: 30 }
/** Beat between the front card and the rest when the stack unfolds or folds.
 *
 *  The expanded list reads top-down in run order, so the front card (bottom,
 *  fused to the composer when collapsed) has to travel to the TOP, past the
 *  cards peeking behind it. Springing everything at once made it cross them
 *  mid-flight; instead it keeps the top layer and rises first, and the rest
 *  wait this long before dropping into their slots beneath it. Collapse runs in
 *  reverse so it lands back on top of them. (The original stack avoided the
 *  crossing by listing bottom-up, which read as the queue being in reverse.) */
const LIFT_STAGGER_S = 0.08

/** Inline editor (textarea + save) swapped in for the message text while editing.
 *  Owns the live value so its own controls commit the typed text, never stale content.
 *
 *  A textarea, not an `<input>`: a queued message can span several lines --
 *  the attachment serializer writes one `[attached_file N] path` marker per
 *  line -- and a single-line input drops every newline from its value, so an
 *  ordinary edit would glue the markers together and the queue edit's
 *  whitespace-bounded marker match would prune every attachment but the last.
 *  Enter commits (the composer's own contract); Shift+Enter inserts a line. */
function EditInput({ initial, onCommit, onCancel }: {
  initial: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const ime = useImeGuard()
  const [value, setValue] = useState(initial)
  // Guard so blur and an explicit save/Enter don't both fire onCommit.
  const committedRef = useRef(false)
  // Select the FIRST line only, never the whole value: the marker lines sit
  // below the single visible row, and a select-all would let an ordinary
  // retype replace them unseen -- the queue edit then prunes every
  // attachment from the send with nothing on screen to say so.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const nl = initial.indexOf('\n')
    el.setSelectionRange(0, nl === -1 ? initial.length : nl)
  }, [initial])
  // Lines below the visible one, surfaced as a count so the hidden part of
  // the value is never a surprise. When every hidden line is an attachment
  // marker (the serializer's `[attached_file N] path` / `[attached_dir N]
  // path` lines) the cue names them as attachments -- "+2 attachments" says
  // what is there, where "+2 lines" only says how much.
  const hidden = value.split('\n').slice(1)
  const hiddenLines = hidden.length
  const hiddenAreAttachments = hiddenLines > 0 && hidden.every(l => /^\[attached_(?:file|dir) \d+\] /.test(l))
  const hiddenCue = hiddenAreAttachments
    ? i18nT('components.queueStack.hidden_attachments', { count: hiddenLines })
    : i18nT('components.queueStack.hidden_lines', { count: hiddenLines })
  // Commit only a real change: skip empty and unchanged values so a stray
  // focus→blur (or clear→blur) doesn't fire a no-op PATCH + WS broadcast.
  const commit = () => {
    if (committedRef.current) return
    committedRef.current = true
    const trimmed = value.trim()
    if (trimmed && trimmed !== initial.trim()) onCommit(value)
    else onCancel()
  }
  const cancel = () => { if (committedRef.current) return; committedRef.current = true; onCancel() }
  return (
    <>
      <textarea
        ref={ref}
        value={value}
        // One visible row: the card is a fixed-height stack slot (CARD_H) and
        // shows the content itself truncated to one line, so the editor shows
        // the same line the card does. The value keeps every newline; the
        // textarea scrolls to the caret as the user moves through the lines.
        rows={1}
        onChange={e => setValue(e.target.value)}
        // Stop the card's expand/collapse + drag handlers from swallowing pointer + key events.
        onPointerDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => {
          e.stopPropagation()
          if (e.key === 'Enter' && !e.shiftKey) {
            // The commit's own emptiness check stays in commit(). claimEnter
            // consumes the keypress, so a committing Enter never inserts a line.
            if (ime.claimEnter(e)) commit()
          } else if (e.key === 'Escape') { e.preventDefault(); ime.reset(); cancel() }
        }}
        {...ime.bindComposition({ onBlur: commit })}
        className="flex-1 min-w-0 resize-none overflow-hidden bg-[var(--bg)] text-[var(--text)] placeholder:text-[var(--muted)] rounded px-1.5 py-0.5 text-[13px] leading-5 outline-none border border-[var(--border)] focus-visible:border-[var(--accent)]"
        aria-label={i18nT('components.queueStack.edit_queued_message')}
      />
      {hiddenLines > 0 && (
        <span className="shrink-0 text-[11px] text-[var(--muted)] tabular-nums" data-testid="queue-edit-hidden-lines"
          title={hiddenCue}>
          {hiddenCue}
        </span>
      )}
      <button className="shrink-0 p-0.5 rounded hover:bg-[var(--bg-hover)] transition-colors text-[var(--text)]"
        title={i18nT('components.queueStack.save')} aria-label={i18nT('components.queueStack.save_edit')}
        // mousedown commits before the input's blur can fire with the same value.
        onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}
        onClick={e => { e.stopPropagation(); commit() }}>
        <Check size={13} />
      </button>
    </>
  )
}

/** One thing a queue card can do. Rendered either as an inline icon button or as
 *  an item in the card's overflow menu — same label, same handler, same
 *  disabled state — so which of the two a given action gets is a layout
 *  decision the row makes, not something each action knows about. */
interface CardAction {
  key: string
  /** Visible menu text and the inline button's aria-label. */
  label: string
  /** Inline button tooltip when it should say more than the label. */
  title?: string
  icon: React.ReactNode
  /** Inline: draw in the foreground text colour rather than the card's warn tint. */
  emphasis?: boolean
  disabled?: boolean
  run: () => void
}

/** The card's overflow menu: every action past the first, so the row itself
 *  never holds more than two controls. Same pattern as `CronRowActions` and
 *  `SessionActionsMenu`. Every pointer/keyboard event is stopped at the trigger
 *  and the content: the stack's own container toggles expand/collapse on click
 *  and Enter/Space, and both the trigger and (through React's portal bubbling)
 *  the menu items sit inside it. */
function QueueCardOverflow({ actions, disabled }: { actions: CardAction[]; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          className="shrink-0 p-0.5 rounded hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          title={i18nT('components.chatInput.more_actions')}
          aria-label={i18nT('components.chatInput.more_actions')}
          disabled={disabled}
          onClick={stop}
          onPointerDown={stop}
          onKeyDown={stop}
        >
          <MoreHorizontal size={13} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]" onClick={stop} onKeyDown={stop}>
        {actions.map(a => (
          <DropdownMenuItem key={a.key} disabled={a.disabled} onSelect={() => { setOpen(false); a.run() }}>
            <span className="shrink-0 inline-flex">{a.icon}</span>
            <span>{a.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function QueueStackInner({ messages, onCancel, onInterrupt, onSteer, onEdit, onReorder, fuseBelow = true, pendingIds }: {
  messages: ChatMessage[]
  onCancel?: (queueId: string) => void
  /** Stop the running turn and start THIS entry as the next turn. */
  onInterrupt?: (queueId: string) => void
  /** Inject THIS entry into the running turn as a steer — the turn keeps going
   *  and reads the text at its next inference boundary. The non-interrupting
   *  sibling of `onInterrupt`: same "act on it now" intent, opposite cost. */
  onSteer?: (queueId: string) => void
  onEdit?: (queueId: string, content: string) => void
  /** Move a queued message one step toward the front (`next`) or the back
   *  (`later`) of the run order. Index 0 runs first. */
  onReorder?: (queueId: string, direction: 'next' | 'later') => void
  /** Queue ids whose cancel/edit is in flight. Their controls are disabled so a
   *  second click cannot fire a duplicate request — on a surface where the card
   *  is only retired once the server confirms, that second request races the
   *  first and comes back 404, reporting a failure for an action that worked. */
  pendingIds?: ReadonlySet<string>
  /** When true (default) the front collapsed card fuses into the surface directly
   *  below it (the input box) via a negative bottom margin + a flat, borderless bottom
   *  edge. Set false when a non-fusable element sits between the queue and the input box
   *  (follow-up option chips or the knowledge chip): the card then keeps its negative
   *  margin off and renders as a complete rounded card cleanly above that element instead
   *  of overlapping it. */
  fuseBelow?: boolean
}) {
  useLanguageGeneration() // memo() bails out of the provider-level repaint; subscribe directly
  const [_expanded, setExpanded] = useState(false)
  const expanded = _expanded && messages.length > 1
  const [editingId, setEditingId] = useState<string | null>(null)

  // Reset expanded when queue drains to trivial size
  useEffect(() => {
    if (messages.length <= 1) setExpanded(false)
  }, [messages.length])

  // Drop a stale edit target if its card leaves the queue (e.g. dequeued / cancelled).
  useEffect(() => {
    if (editingId && !messages.some(m => (m.meta?.queueId as string) === editingId)) setEditingId(null)
  }, [messages, editingId])

  const commitEdit = (queueId: string, content: string) => {
    setEditingId(null)
    if (onEdit) onEdit(queueId, content)
  }
  const cancelEdit = () => setEditingId(null)

  const peekCount = Math.min(MAX_PEEK, Math.max(0, messages.length - 1))
  const collapsedHeight = messages.length > 0 ? CARD_H + peekCount * PEEK : 0
  const expandedHeight = messages.length > 0 ? messages.length * CARD_H + (messages.length - 1) * EXPANDED_GAP : 0

  const targetHeight = expanded ? expandedHeight : collapsedHeight
  const targetMargin = messages.length > 0 && !expanded && fuseBelow ? -OVERLAP : 0

  // Imperatively control margin: spring on expand/collapse, snap on enter/exit
  const marginMV = useMotionValue(targetMargin)
  const marginSpring = useSpring(marginMV, SPRING)
  const prevExpanded = useRef(expanded)

  useEffect(() => {
    const expandChanged = prevExpanded.current !== expanded
    prevExpanded.current = expanded

    if (expandChanged) {
      // Expand/collapse: animate via spring
      marginMV.set(targetMargin)
    } else if (messages.length > 0) {
      // Enter (count increased) or count decreased but not to 0: snap immediately
      // When count hits 0, let onExitComplete handle the margin reset
      marginSpring.jump(targetMargin)
    }
  }, [expanded, targetMargin, messages.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Handle last-card exit: snap margin to 0 when AnimatePresence finishes
  const prevCountForExit = useRef(messages.length)
  const hasExitingRef = useRef(false)
  useEffect(() => {
    if (messages.length < prevCountForExit.current) hasExitingRef.current = true
    prevCountForExit.current = messages.length
  }, [messages.length])

  const onExitComplete = () => {
    hasExitingRef.current = false
    if (messages.length === 0) marginSpring.jump(0)
  }

  /** The card's row: index, text (or the inline editor), and its action
   *  controls. Pulled out of the card loop so the loop reads as geometry and
   *  motion only; the row itself does not depend on where the card sits.
   *
   *  The action row holds AT MOST two controls (`max-two-buttons-per-row`): the
   *  first action inline, and — when there is more than one other — a single
   *  overflow menu carrying the rest. With two actions or fewer (the side chat's
   *  edit + cancel) both stay inline and no menu is rendered. Order is the
   *  action list's, so what stays visible is decided once, up front: Steer now
   *  when the host offers it (the non-interrupting "act on it now", the reason
   *  the card is worth a control while a turn runs), else Send now, else Edit. */
  const cardBody = (
    m: ChatMessage,
    i: number,
    { isFrontCollapsed, isEditing, queueId, isPending, showActions }: {
      isFrontCollapsed: boolean; isEditing: boolean; queueId: string | undefined; isPending: boolean; showActions: boolean
    },
  ) => {
    const actions: CardAction[] = []
    if (showActions && onSteer) {
      actions.push({
        key: 'steer',
        label: i18nT('components.queueStack.steer_now'),
        // The chord acts on the FRONT card only (it is what an empty-composer
        // ⌘↩ steers), so only that card advertises it — a chord on card 3 would
        // promise something the key does not do.
        title: i === 0
          ? i18nT('components.queueStack.steer_this_into_the_running_turn_now_without_interrupting_chord', { chord: platformShortcut('Cmd+Enter') })
          : i18nT('components.queueStack.steer_this_into_the_running_turn_now_without_interrupting'),
        icon: <Target size={13} />,
        emphasis: true,
        disabled: isPending,
        run: () => onSteer(queueId!),
      })
    }
    if (showActions && onInterrupt) {
      actions.push({
        key: 'interrupt',
        label: i18nT('components.queueStack.send_now'),
        title: i18nT('components.queueStack.interrupt_current_turn_and_send_this_now'),
        icon: <Zap size={13} fill="currentColor" />,
        emphasis: true,
        disabled: isPending,
        run: () => onInterrupt(queueId!),
      })
    }
    if (showActions && onEdit) {
      actions.push({
        key: 'edit',
        label: i18nT('components.queueStack.edit_queued_message'),
        icon: <Pencil size={13} />,
        disabled: isPending,
        run: () => setEditingId(queueId!),
      })
    }
    // Reorder only makes sense with 2+ cards, and only in the expanded stack
    // where the run order is visible. The list reads top-down in run order
    // (index 0 on top), so "run sooner" moves the card UP: ↑ sooner, ↓ later.
    if (onReorder && expanded && messages.length > 1) {
      actions.push({
        key: 'sooner',
        label: i18nT('components.queueStack.run_sooner'),
        icon: <ArrowUp size={13} />,
        disabled: i === 0,
        run: () => onReorder(queueId!, 'next'),
      })
      actions.push({
        key: 'later',
        label: i18nT('components.queueStack.run_later'),
        icon: <ArrowDown size={13} />,
        disabled: i === messages.length - 1,
        run: () => onReorder(queueId!, 'later'),
      })
    }
    if (showActions && onCancel) {
      actions.push({
        key: 'cancel',
        label: i18nT('components.queueStack.cancel_queued_message'),
        title: i18nT('components.queueStack.cancel_and_move_back_to_input'),
        icon: <X size={13} />,
        disabled: isPending,
        run: () => onCancel(queueId!),
      })
    }
    const inline = actions.length <= 2 ? actions : actions.slice(0, 1)
    const overflow = actions.length <= 2 ? [] : actions.slice(1)

    return (
      <span className="flex items-center gap-1.5 h-full">
        <span className="shrink-0 text-[10px] font-mono opacity-50 w-4 text-center">{i + 1}</span>
        {isFrontCollapsed && (
          <span className="shrink-0 inline-flex animate-[hourglass-flip_3s_ease-in-out_infinite]">
            <Hourglass size={13} />
          </span>
        )}
        {isEditing && onEdit ? (
          <EditInput initial={m.content} onCommit={v => commitEdit(queueId!, v)} onCancel={cancelEdit} />
        ) : (
          <>
            <span className="truncate flex-1">{m.content}</span>
            {inline.map(a => (
              <button
                key={a.key}
                className={`shrink-0 p-0.5 rounded hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent ${a.emphasis ? 'text-[var(--text)]' : ''}`}
                title={a.title ?? a.label}
                aria-label={a.label}
                disabled={a.disabled}
                onClick={(e) => { e.stopPropagation(); a.run() }}
              >
                {a.icon}
              </button>
            ))}
            {overflow.length > 0 && (
              <QueueCardOverflow actions={overflow} disabled={isPending} />
            )}
            {isFrontCollapsed && messages.length > 1 && (
              <span className="shrink-0 flex items-center gap-1 text-[11px] opacity-70">
                {messages.length} {i18nT('components.queueStack.queued')}
                <ChevronUp size={12} />
              </span>
            )}
            {/* Collapse affordance stays on the card nearest the
                composer — the stack folds down onto that edge. */}
            {expanded && i === messages.length - 1 && (
              <ChevronUp size={13} className="shrink-0 opacity-50 rotate-180" />
            )}
          </>
        )}
      </span>
    )
  }

  return (
    // `zIndex: 2` clears the transcript's bottom mask (`z-[1]`), whose
    // COMPOSER_MASK_OVERSHOOT_PX tail reaches below the scrollport edge on the
    // premise that the composer's own gap is what sits there. When this stack is
    // the first thing under the transcript the tail lands on the front card
    // instead and shaved its top border and corners. Still far below the
    // composer's own `z-10`, so the collapsed card's -OVERLAP fuse keeps sliding
    // UNDER the input box rather than over it.
    <div className="px-4 mx-auto w-full relative" style={{ maxWidth: 'var(--mc-content-width, 900px)', zIndex: 2 }}>
      <motion.div
        className="relative cursor-pointer"
        animate={{ height: targetHeight }}
        transition={SPRING}
        style={{ marginBottom: marginSpring }}
        onClick={() => messages.length > 1 && setExpanded(e => !e)}
        onKeyDown={(e: React.KeyboardEvent) => {
          if ((e.key === 'Enter' || e.key === ' ') && messages.length > 1) {
            e.preventDefault()
            setExpanded(prev => !prev)
          }
        }}
        role={messages.length > 1 ? 'button' : undefined}
        tabIndex={messages.length > 1 ? 0 : undefined}
        aria-expanded={messages.length > 1 ? expanded : undefined}
      >
        <AnimatePresence initial={false} onExitComplete={onExitComplete}>
          {messages.map((m, i) => {
            const n = messages.length
            const listY = (idx: number) => idx * (CARD_H + EXPANDED_GAP)
            // Collapsed geometry: the front card sits at the bottom, fused to the
            // composer; each deeper card peeks PEEK px above the one before it.
            const peek = i <= MAX_PEEK
              ? {
                  y: (collapsedHeight - CARD_H) - i * PEEK,
                  scale: 1 - (i + 1) * SCALE_STEP,
                  opacity: 1,
                  zIndex: (MAX_PEEK + 1) - i,
                  brightness: DEPTH_BRIGHTNESS[i] ?? DEPTH_BRIGHTNESS[MAX_PEEK],
                }
              : {
                  y: (collapsedHeight - CARD_H) - MAX_PEEK * PEEK,
                  scale: 1 - (MAX_PEEK + 1) * SCALE_STEP - HIDDEN_EXTRA_SCALE,
                  opacity: 0,
                  zIndex: 0,
                  brightness: DEPTH_BRIGHTNESS[MAX_PEEK],
                }

            let y: number
            let scale: number
            let opacity: number
            let zIndex: number
            let brightness: number
            // Stagger applies only on the render that flips `expanded`. On any other
            // re-render (a card added or drained) nothing here should wait: a freshly
            // promoted front card must not pause before sliding into its slot.
            const toggling = prevExpanded.current !== expanded
            let transition: typeof SPRING & { delay?: number } = SPRING

            if (expanded) {
              // Run order reads top-down: index 0 (runs next) on top, like a list.
              y = listY(i)
              scale = 1
              opacity = 1
              brightness = 1
              // The front card owns the top layer in BOTH states, so it never dives
              // under the cards it passes on its way up; the rest hold their peek
              // positions for one beat and then drop into their slots beneath it.
              zIndex = i === 0 ? n + 2 : i + 1
              if (toggling && i > 0) transition = { ...SPRING, delay: LIFT_STAGGER_S }
            } else {
              ;({ y, scale, opacity, zIndex, brightness } = peek)
              if (i === 0) {
                zIndex = n + 2
                // Reverse order on collapse: the rest return to their peeks first, and
                // the front card lands back on top of them last.
                if (toggling) transition = { ...SPRING, delay: LIFT_STAGGER_S }
              }
            }

            const isFrontCollapsed = !expanded && i === 0
            // Flat, borderless bottom (to seam into the input box) only when we're
            // actually fusing into the surface below. When fuseBelow is off, keep the
            // card fully rounded/bordered so it doesn't look cut off above the chips.
            const fused = isFrontCollapsed && fuseBelow
            const queueId = m.meta?.queueId as string | undefined
            const isEditing = !!queueId && editingId === queueId
            const isPending = !!queueId && !!pendingIds?.has(queueId)
            // Per-card actions show on the front single card or when expanded.
            const showActions = (expanded || messages.length === 1) && !!queueId

            return (
              <motion.div
                key={m.meta?.queueId as string ?? m.ts ?? `q-${i}-${m.content}`}
                initial={false}
                animate={{
                  opacity, y, scale,
                  filter: `brightness(${brightness})`,
                  borderTopLeftRadius: 12,
                  borderTopRightRadius: 12,
                  borderBottomLeftRadius: fused ? 0 : 12,
                  borderBottomRightRadius: fused ? 0 : 12,
                  borderBottomWidth: fused ? 0 : 1,
                }}
                exit={{ y: y + 40, zIndex: 50, borderBottomWidth: 1, borderBottomLeftRadius: 12, borderBottomRightRadius: 12, transition: SPRING }}
                transition={transition}
                // Theme colors are raw var(--x) without <alpha-value>, so Tailwind
                // alpha modifiers (bg-warn/15) silently generate no CSS. Use explicit
                // color-mix instead — and mix the bg toward the opaque surface color
                // (not transparent): cards overlap in the collapsed peek stack, so a
                // translucent bg would let the cards behind bleed through. The
                // kiro-dark .queue-card override in index.css still takes precedence.
                className="queue-card absolute top-0 left-0 right-0 bg-[color-mix(in_srgb,var(--warn)_15%,var(--bg-elevated))] border border-[color-mix(in_srgb,var(--warn)_40%,transparent)] px-3 py-2 text-[13px] text-warn"
                style={{ transformOrigin: 'bottom center', height: CARD_H, zIndex }}
              >
                {cardBody(m, i, { isFrontCollapsed, isEditing, queueId, isPending, showActions })}
              </motion.div>
            )
          })}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}

export default memo(QueueStackInner, (prev, next) =>
  prev.messages.length === next.messages.length &&
  prev.fuseBelow === next.fuseBelow &&
  prev.pendingIds === next.pendingIds &&
  prev.messages.every((m, i) => m === next.messages[i]) &&
  prev.onCancel === next.onCancel &&
  prev.onInterrupt === next.onInterrupt &&
  prev.onSteer === next.onSteer &&
  prev.onEdit === next.onEdit &&
  prev.onReorder === next.onReorder
)
