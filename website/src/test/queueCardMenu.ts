import { fireEvent, screen } from '@testing-library/react'

/**
 * Drive a queue card's overflow menu (`QueueCardOverflow`) in jsdom.
 *
 * The card row keeps at most two controls: the first action inline and the
 * rest behind a `More actions` trigger. Radix opens a DropdownMenu on keyboard
 * in jsdom (pointer events do not carry the coordinates it wants), so open with
 * Enter on the trigger, then click the item by its accessible name.
 */
export async function openQueueCardMenu(): Promise<HTMLButtonElement> {
  const trigger = (await screen.findByRole('button', { name: 'More actions' })) as HTMLButtonElement
  fireEvent.keyDown(trigger, { key: 'Enter' })
  return trigger
}

export async function clickQueueCardMenuItem(name: string): Promise<void> {
  await openQueueCardMenu()
  const item = await screen.findByRole('menuitem', { name })
  fireEvent.click(item)
}
