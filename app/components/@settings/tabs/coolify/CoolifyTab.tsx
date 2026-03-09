import React from 'react';
import { motion } from 'framer-motion';
import CoolifyConnection from './components/CoolifyConnection';

// Coolify logo SVG component
const CoolifyLogo = () => (
  <svg viewBox="0 0 40 40" className="w-6 h-6">
    <circle cx="20" cy="20" r="18" fill="currentColor" opacity="0.1" />
    <path
      fill="currentColor"
      d="M20 6C12.268 6 6 12.268 6 20s6.268 14 14 14 14-6.268 14-14S27.732 6 20 6zm0 24c-5.523 0-10-4.477-10-10S14.477 10 20 10s10 4.477 10 10-4.477 10-10 10zm-2-14a2 2 0 1 1 4 0v4a2 2 0 1 1-4 0v-4z"
    />
  </svg>
);

export default function CoolifyTab() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="p-6 space-y-6"
    >
      <div className="flex items-center gap-3">
        <CoolifyLogo />
        <div>
          <h3 className="text-lg font-medium text-bolt-elements-textPrimary">Coolify Live Preview</h3>
          <p className="text-sm text-bolt-elements-textSecondary">
            Self-hosted preview containers with shareable URLs
          </p>
        </div>
      </div>

      <div className="border-t border-bolt-elements-borderColor pt-4">
        <CoolifyConnection />
      </div>
    </motion.div>
  );
}
