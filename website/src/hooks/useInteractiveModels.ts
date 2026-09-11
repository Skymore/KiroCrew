import { useQuery } from '@tanstack/react-query'

import { api } from '../api/client'
import type { ModelInfo } from '../providers/types'

export function normalizeHiddenModels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const model = raw.trim()
    if (!model || model === 'auto' || seen.has(model)) continue
    seen.add(model)
    result.push(model)
  }
  return result
}

export function filterInteractiveModels(
  models: ModelInfo[],
  hiddenModels: readonly string[],
  activeModels: readonly string[] = [],
): ModelInfo[] {
  const hidden = new Set(hiddenModels)
  const kept = new Set(activeModels.filter(Boolean))
  return models.filter(model => model.name === 'auto' || kept.has(model.name) || !hidden.has(model.name))
}

export function useModelPickerHiddenModels(): string[] {
  const { data } = useQuery({
    queryKey: ['dashboardConfig'],
    queryFn: () => api.dashboardConfig(),
  })
  return normalizeHiddenModels(data?.model_picker_hidden_models)
}
