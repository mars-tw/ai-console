import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EN } from '@/i18n/en'

const files = [
  '../components/QuickDispatch.tsx',
  '../components/ContinueWorkDialog.tsx',
  '../components/Console.tsx',
  '../components/Office.tsx',
  '../mobile/MobileApp.tsx',
  '../pages/Home.tsx',
] as const

describe('unified ChatGPT route translations', () => {
  it('has an English entry for every literal label used by the changed route surfaces', () => {
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      const labels = [...source.matchAll(/\bt\('((?:\\'|[^'])+)'/g)]
        .map(match => match[1].replace(/\\'/g, "'"))
      for (const label of labels) expect(EN[label], `${file}: ${label}`).toBeTruthy()
    }
  })
})
