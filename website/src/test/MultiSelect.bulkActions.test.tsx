vi.mock('@radix-ui/react-popover', async () => await import('./__mocks__/@radix-ui/react-popover'))

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import MultiSelect from '../components/MultiSelect'

describe('MultiSelect bulk actions', () => {
  it('keeps bulk actions keyboard reachable beside search without toggling rows', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const selectAll = vi.fn()
    const deselectAll = vi.fn()
    render(
      <MultiSelect
        label="Selectable Models"
        options={[
          { value: 'auto', label: 'auto', locked: true },
          { value: 'model-a', label: 'model-a' },
        ]}
        selected={new Set(['auto'])}
        onToggle={onToggle}
        bulkActions={[
          { label: 'Select all', onSelect: selectAll },
          { label: 'Deselect all', onSelect: deselectAll },
        ]}
        summary="Selected 1 / 2"
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Selectable Models' }))
    const search = screen.getByRole('textbox', { name: 'Search…' })
    expect(search).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Select all' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(selectAll).toHaveBeenCalledOnce()
    expect(onToggle).not.toHaveBeenCalled()

    await user.tab()
    expect(screen.getByRole('button', { name: 'Deselect all' })).toHaveFocus()
    await user.keyboard(' ')
    expect(deselectAll).toHaveBeenCalledOnce()
    expect(onToggle).not.toHaveBeenCalled()
  })
})
