import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AsciiTorus from './AsciiTorus';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AsciiTorus />
    <a className="credit" href="https://x.com/yasircli">
      made by @yasircli
    </a>
  </StrictMode>,
);
