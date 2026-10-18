import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../App';
import ToolStatesPreview from './ToolStatesPreview';
import DeviceToolsPreview from './DeviceToolsPreview';

// The regular route keeps the real unavailable-engine state. The explicit
// visual fixture route never installs or invents a native bridge.
const toolStates = /^\/tool-states\/?$/.test(window.location.pathname);
createRoot(document.getElementById('root')).render(
  toolStates ? (
    <ToolStatesPreview />
  ) : /^\/device-tool-states\/?$/.test(window.location.pathname) ? (
    <DeviceToolsPreview />
  ) : (
    <App />
  ),
);
