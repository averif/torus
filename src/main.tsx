import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AsciiTorus from './AsciiTorus';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AsciiTorus />
  </StrictMode>,
);
