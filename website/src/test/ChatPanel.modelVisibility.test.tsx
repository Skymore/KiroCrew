vi.mock('@radix-ui/react-select', async () => await import('./__mocks__/@radix-ui/react-select'))
vi.mock('@radix-ui/react-popover', async () => await import('./__mocks__/@radix-ui/react-popover'))

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Provider } from 'react-redux'

const { dashboardConfigMock, updateDashboardConfigMock } = vi.hoisted(() => ({
  dashboardConfigMock: vi.fn(),
  updateDashboardConfigMock: vi.fn(),
}))

vi.mock('../api/client', () => ({
  api: {
    dashboardConfig: dashboardConfigMock,
    updateDashboardConfig: updateDashboardConfigMock,
    kirocrewConfig: () => Promise.resolve({ agent: { model: 'auto', reasoning_effort: '' } }),
    models: () => Promise.resolve([
      { model_name: 'auto', description: 'Default' },
      { model_name: 'model-a', description: 'Model A' },
      { model_name: 'model-b', description: 'Model B' },
    ]),
    patchConfig: () => Promise.resolve({}),
    tipsStatus: () => Promise.resolve({ enabled_config: true, opted_out: false }),
    tipsFeedback: () => Promise.resolve({ ok: true }),
    featureVideoStatus: () => Promise.resolve({ enabled: false }),
    featureVideoFetchAll: () => Promise.resolve({ ok: true }),
  },
}))

import { ChatPanel } from '../pages/settings/ChatPanel'
import { createTestStore } from './helpers'

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return Object.assign(render(
    <Provider store={createTestStore()}>
      <QueryClientProvider client={client}><ChatPanel /></QueryClientProvider>
    </Provider>,
  ), { client })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  dashboardConfigMock.mockReset().mockResolvedValue({
    restore_sessions: false,
    restore_window_minutes: 30,
    merge_queued_messages: false,
    default_memory_mode: 'persistent',
    widget_density: 'more',
    verbosity: 'default',
    quick_send: false,
    session_grid: false,
    tail_fork_enabled: false,
    link_previews: false,
    mcp_app_panel: false,
    auto_open_git_panel: false,
    session_card_source_links: true,
    folder_suggestions_enabled: true,
    use_builtin_browser: true,
    model_picker_hidden_models: [],
  })
  updateDashboardConfigMock.mockReset().mockResolvedValue({ ok: true })
})

describe('Settings selectable models', () => {
  it('defaults to all selected, searches, persists hidden IDs, and locks auto', async () => {
    mount()
    const trigger = await screen.findByRole('button', { name: 'Selectable Models' })
    await waitFor(() => expect(trigger).toHaveTextContent('All models (3)'))
    fireEvent.click(trigger)

    const auto = screen.getByRole('checkbox', { name: 'auto' })
    expect(auto).toBeChecked()
    expect(auto).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'model-a' })).toBeChecked()
    expect(auto.closest('label')).toHaveClass('min-h-11')

    fireEvent.change(screen.getByRole('textbox', { name: 'Search models…' }), { target: { value: 'model-b' } })
    expect(screen.getByRole('checkbox', { name: 'model-b' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'model-a' })).toBeNull()

    fireEvent.change(screen.getByRole('textbox', { name: 'Search models…' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'model-a' }))
    await waitFor(() => expect(updateDashboardConfigMock).toHaveBeenCalledWith({
      model_picker_hidden_models: ['model-a'],
    }))
    expect(trigger).toHaveTextContent('Selected 2 / 3')
  })

  it('moves from search through options with arrow keys and toggles the focused row', async () => {
    mount()
    const trigger = await screen.findByRole('button', { name: 'Selectable Models' })
    await waitFor(() => expect(trigger).toHaveTextContent('All models (3)'))
    fireEvent.click(trigger)
    const search = screen.getByRole('textbox', { name: 'Search models…' })
    search.focus()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const autoRow = screen.getByRole('checkbox', { name: 'auto' }).closest('label') as HTMLElement
    expect(autoRow).toHaveFocus()
    fireEvent.keyDown(autoRow, { key: 'ArrowDown' })
    const modelARow = screen.getByRole('checkbox', { name: 'model-a' }).closest('label') as HTMLElement
    expect(modelARow).toHaveFocus()
    fireEvent.keyDown(modelARow, { key: ' ' })
    await waitFor(() => expect(updateDashboardConfigMock).toHaveBeenCalledWith({
      model_picker_hidden_models: ['model-a'],
    }))
  })

  it('rolls the edited selection back when persistence fails', async () => {
    updateDashboardConfigMock.mockRejectedValueOnce(new Error('write failed'))
    mount()
    const trigger = await screen.findByRole('button', { name: 'Selectable Models' })
    await waitFor(() => expect(trigger).toHaveTextContent('All models (3)'))
    fireEvent.click(trigger)
    const modelB = screen.getByRole('checkbox', { name: 'model-b' })
    fireEvent.click(modelB)

    expect(await screen.findByText('Failed to save selectable models')).toBeInTheDocument()
    expect(modelB).toBeChecked()
    expect(trigger).toHaveTextContent('All models (3)')
  })

  it('serializes rapid replacements so the newest selection is the server final value', async () => {
    const first = deferred<{ ok: true }>()
    const second = deferred<{ ok: true }>()
    updateDashboardConfigMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    mount()
    const trigger = await screen.findByRole('button', { name: 'Selectable Models' })
    await waitFor(() => expect(trigger).toHaveTextContent('All models (3)'))
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('checkbox', { name: 'model-a' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'model-b' }))
    expect(trigger).toHaveTextContent('Selected 1 / 3')
    await waitFor(() => expect(updateDashboardConfigMock).toHaveBeenCalledTimes(1))

    first.resolve({ ok: true })
    await waitFor(() => expect(updateDashboardConfigMock).toHaveBeenCalledTimes(2))
    expect(updateDashboardConfigMock).toHaveBeenLastCalledWith({
      model_picker_hidden_models: ['model-a', 'model-b'],
    })
    second.resolve({ ok: true })
    await waitFor(() => expect(trigger).toHaveTextContent('Selected 1 / 3'))
    expect(trigger).toHaveTextContent('Selected 1 / 3')
  })
})
