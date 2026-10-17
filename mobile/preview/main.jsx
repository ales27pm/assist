import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../App';

// Render the native app itself, with its real unavailable-engine state.
createRoot(document.getElementById('root')).render(<App />);
