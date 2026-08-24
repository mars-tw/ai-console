// 系統通知模組
//
// 核心用途：派工往往需要數十秒至數分鐘，使用者在派工送出後通常會切換到其他視窗作業。
// 當背景任務結束時，透過作業系統層級通知提醒使用者回到應用程式查看結果。
//
// 設計原則：
// 1. 優先使用 Electron preload 暴露的 acNotify（原生 Windows/macOS 整合、支援點擊喚醒視窗）。
// 2. 瀏覽器開發模式退回標準 Web Notification API。
// 3. 兩者皆不可用或權限不足時靜默忽略，嚴禁拋出例外或跳出 alert 阻斷主要邏輯。
// 4. 開發者與使用者可透過 localStorage 的 ac_notify 鍵值控制開關（預設為開啟）。

import { t } from '@/i18n'

/** 使用者在 localStorage 設定的開關鍵名（預設開） */
export const NOTIFY_STORAGE_KEY = 'ac_notify'

/**
 * 檢查使用者是否啟用了系統通知。
 *
 * 預設為開啟：若 localStorage 中沒有此設定或值非 'false'/'0'，皆視為開啟。
 * 存取 localStorage 必須包在 try/catch 內，因為在無痕模式或跨來源受限環境下，
 * 存取 localStorage 會拋出 SecurityError，若未捕獲將直接導致整個前端介面崩潰。
 */
export function isNotifyEnabled(): boolean {
  try {
    const val = localStorage.getItem(NOTIFY_STORAGE_KEY)
    if (val === 'false' || val === '0') return false
    return true
  } catch {
    // 存取受阻時維持預設開啟，避免阻斷後續正常流程
    return true
  }
}

/**
 * 更新系統通知開關設定。
 */
export function setNotifyEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(NOTIFY_STORAGE_KEY, enabled ? 'true' : 'false')
  } catch {
    // 寫入失敗（如儲存配額滿或權限受限）時靜默忽略，不中斷主要流程
  }
}

export interface NotifyDoneOptions {
  tool: string
  ok: boolean
  summary: string
}

interface AcNotifyApi {
  available: () => Promise<boolean>
  send: (opts: { title: string; body: string; id?: string }) => Promise<boolean>
}

/**
 * 派工結束時發出作業系統通知。
 *
 * @param o 派工結果參數（使用的工具、成功/失敗、摘要）
 * @returns 是否成功送出通知
 */
export async function notifyDone(o: NotifyDoneOptions): Promise<boolean> {
  // 開頭先檢查開關：使用者若已明確關閉通知，應立即返回，避免多餘的 IPC 呼叫或跳出權限請求打擾使用者
  if (!isNotifyEnabled()) return false

  const toolName = o.tool ? o.tool.trim() : t('AI')
  const title = o.ok
    ? t('{tool} 派工完成', { tool: toolName })
    : t('{tool} 派工失敗', { tool: toolName })
  const body = o.summary && o.summary.trim()
    ? o.summary.trim()
    : (o.ok ? t('任務已完成') : t('任務執行失敗'))

  try {
    // 1. 桌面版（Electron）：走 preload 暴露的 acNotify，支援點擊自動切換至前景視窗
    if (typeof window !== 'undefined') {
      const ac = (window as unknown as { acNotify?: AcNotifyApi }).acNotify
      if (ac && typeof ac.send === 'function') {
        const sent = await ac.send({ title, body })
        if (sent) return true
      }

      // 2. 瀏覽器開發模式：退回 Web Notification API
      if ('Notification' in window) {
        const WebNotification = window.Notification
        if (WebNotification.permission === 'granted') {
          new WebNotification(title, { body })
          return true
        }
        // 若權限尚未被拒絕（處於 default 狀態），嘗試請求授權；若使用者忽略或拒絕則不強求
        if (WebNotification.permission === 'default') {
          const permission = await WebNotification.requestPermission().catch(() => 'default' as NotificationPermission)
          if (permission === 'granted') {
            new WebNotification(title, { body })
            return true
          }
        }
      }
    }
  } catch {
    // 嚴禁在此處拋出例外或使用 alert()：
    // 通知純屬體驗輔助，若因作業系統不支援、通知伺服器異常或無權限而報錯，絕不能阻斷呼叫端的派工狀態更新。
  }

  return false
}
