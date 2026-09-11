import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { filterInteractiveModels, normalizeHiddenModels } from '../hooks/useInteractiveModels'

const MODELS = [
  { name: 'auto', description: '' },
  { name: 'model-a', description: 'A' },
  { name: 'model-b', description: 'B' },
]

describe('interactive model visibility', () => {
  it('shows the full list when the hidden setting is absent or empty', () => {
    expect(filterInteractiveModels(MODELS, []).map(model => model.name)).toEqual(['auto', 'model-a', 'model-b'])
    expect(normalizeHiddenModels(undefined)).toEqual([])
  })

  it('filters hidden models but always keeps auto and the active model', () => {
    expect(filterInteractiveModels(MODELS, ['auto', 'model-a', 'model-b'], ['model-b']).map(model => model.name))
      .toEqual(['auto', 'model-b'])
  })

  it('trims, deduplicates, and ignores invalid config entries', () => {
    expect(normalizeHiddenModels([' model-a ', 'model-a', '', 'auto', 3])).toEqual(['model-a'])
  })

  it('is wired only into ChatPage and ChatPane consumers', () => {
    const root = resolve(process.cwd(), 'src')
    const chatPage = readFileSync(resolve(root, 'pages/ChatPage.tsx'), 'utf8')
    const chatPane = readFileSync(resolve(root, 'components/ChatPane.tsx'), 'utf8')
    const bulkSwitcher = readFileSync(resolve(root, 'pages/ChatSidebar.tsx'), 'utf8')
    const settings = readFileSync(resolve(root, 'pages/settings/ChatPanel.tsx'), 'utf8')
    expect(chatPage).toContain('filterInteractiveModels(effectiveModels')
    expect(chatPane).toContain('filterInteractiveModels(effectiveModels')
    expect(bulkSwitcher).not.toContain('filterInteractiveModels(')
    expect(settings).not.toContain('filterInteractiveModels(')
  })
})
