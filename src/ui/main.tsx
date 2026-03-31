import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import './index.css'
import App from './App.tsx'
import { store } from './state/store'
import { ToastContextProvider } from './components/ui/use-toast'
import { Toaster } from './components/ui/Toaster'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <ToastContextProvider>
        <App />
        <Toaster />
      </ToastContextProvider>
    </Provider>
  </StrictMode>,
)
