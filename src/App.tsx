import { Route, Routes } from 'react-router'
import Home from './pages/Home'

/**
 * The app no longer watches legacy dispatch records in the background. Reading a status page must
 * never start, continue, retry, queue, or auto-hand off coding work.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
    </Routes>
  )
}
