// WP-01 scaffold — CLIENT.md §1 L45: createRoot, mount <App/>.
//
// The keyboard dispatcher (`keyboard/dispatcher.ts`, CLIENT.md §5) is installed here by WP-12;
// this file only owns the root and the global stylesheet import.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './theme/tokens.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html is missing <div id="root">');
}

// Theme and density live on <html> (CLIENT.md §12.3); index.html ships the defaults, the settings
// store takes over in WP-12. Only fill them in when the document did not.
const root = document.documentElement;
root.dataset.theme ??= 'dark';
root.dataset.density ??= 'normal';

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
