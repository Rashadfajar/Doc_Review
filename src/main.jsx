import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import "pdfjs-dist/web/pdf_viewer.css";
import './index.css'
import App from './App.jsx'


createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
