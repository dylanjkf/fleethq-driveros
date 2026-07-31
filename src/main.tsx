import './instrument' // must run before any other import — see instrument.ts's own header comment
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import './index.css'
import App from './App.tsx'
import { registerServiceWorker } from './lib/register-sw'

registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sentry.ErrorBoundary
      fallback={
        <div className="flex h-screen items-center justify-center p-6 text-center">
          <div>
            <p className="text-lg font-semibold">Something went wrong.</p>
            <p className="mt-1 text-sm opacity-70">The error's been reported. Try reloading the page.</p>
          </div>
        </div>
      }
    >
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
)
