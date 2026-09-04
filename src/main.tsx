import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary'
import { initTheme } from './theme'
import MobileApp from './mobile/MobileApp'

// 在 React 掛載之前就套用，不然會先閃一下另一個主題
initTheme()

// /m 是手機遙控頁：同一份前端，靠路徑分流。它跑在遙控埠上，每個 /api 請求都要帶配對 token
//（MobileApp 自己把 fetch 包起來）。不走 App：桌面主控台含對話，遙控不開。
const isMobileRemote = location.pathname === '/m' || location.pathname.startsWith('/m/')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {isMobileRemote ? (
        <MobileApp />
      ) : (
        <BrowserRouter>
          <App />
        </BrowserRouter>
      )}
    </ErrorBoundary>
  </StrictMode>,
)
