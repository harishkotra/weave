import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/archivo';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import App from './App';

const host = document.getElementById('root');
if (!host) throw new Error('Weave could not find #root.');

createRoot(host).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);