import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const script = path.resolve('scripts/create-desktop-shortcut.ps1')

describe('Windows desktop shortcut launcher', () => {
  it('ships UTF-8 BOM so Windows PowerShell reads the executable and shortcut names correctly', () => {
    const bytes = readFileSync(script)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })

  it.skipIf(process.platform !== 'win32')('parses the shipped script with Windows PowerShell without executing it', () => {
    const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $tokens = $null
      $parseErrors = $null
      $tree = [System.Management.Automation.Language.Parser]::ParseFile(
        $env:AI_CONSOLE_SHORTCUT_TEST_SCRIPT, [ref]$tokens, [ref]$parseErrors)
      $strings = $tree.FindAll({ param($node)
        $node -is [System.Management.Automation.Language.StringConstantExpressionAst]
      }, $true) | ForEach-Object { $_.Value }
      $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{
        errors = @($parseErrors).Count; strings = @($strings)
      } | ConvertTo-Json -Compress)))
      Write-Output $encoded
    `], { encoding: 'utf8', windowsHide: true, env: { ...process.env, AI_CONSOLE_SHORTCUT_TEST_SCRIPT: script } })
    const parsed = JSON.parse(Buffer.from(result.trim(), 'base64').toString('utf8'))
    expect(parsed.errors).toBe(0)
    expect(parsed.strings).toContain('release\\clean\\AI控制台-win32-x64\\AI控制台.exe')
    expect(parsed.strings).toContain('DevSpace 控制台.lnk')
    expect(parsed.strings).toContain(' --devspace')
  })
})
